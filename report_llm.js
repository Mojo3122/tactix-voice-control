// ════════════════════════════════════════════════════════════════
//  report_llm.js — Report Assistant (offline LLM Q&A over .docx reports)
//
//  Adds three endpoints under /api/reports and /api/llm:
//    GET  /api/reports                  → list available .docx reports
//    GET  /api/reports/:name/text       → extracted text+tables (cached)
//    POST /api/llm/chat                 → ask gemma3 (via Ollama) about a report
//    GET  /api/llm/health               → is Ollama reachable + model present
//
//  Everything runs offline:
//    - .docx is read locally (adm-zip + direct XML parse, captures tables)
//    - the LLM is your local Ollama (gemma3:1b) on the Windows host
//
//  Config (env):
//    REPORTS_DIR   folder containing Evaluation_Report_*.docx
//                  (mounted into the container — see docker-compose.yml)
//    OLLAMA_URL    base URL of the Ollama host API
//                  In Docker on Windows the host is reachable as
//                  http://host.docker.internal:11434
//    OLLAMA_MODEL  model tag to use (default: gemma3:1b)
// ════════════════════════════════════════════════════════════════
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const router = express.Router();

const REPORTS_DIR  = process.env.REPORTS_DIR  || '/reports';
const OLLAMA_URL   = (process.env.OLLAMA_URL  || 'http://host.docker.internal:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma3:1b';

// Cap how much report text we feed the model. gemma3:1b has a small effective
// context; ~12k chars keeps prompts responsive on CPU while covering a typical
// evaluation report (text + tables). Long reports are truncated with a marker.
const MAX_CONTEXT_CHARS = 12000;

// ── .docx → text+tables ───────────────────────────────────────────
function _decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
function _runsText(xml) {
  // Note: `<w:t ...>` only — the optional-space form avoids matching <w:tcW>, <w:tcPr>, etc.
  return _decode([...xml.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m => m[1]).join(''));
}

// Extract paragraphs and tables in true document order.
function docxToText(filePath) {
  const zip = new AdmZip(filePath);
  const entry = zip.getEntry('word/document.xml');
  if (!entry) throw new Error('Not a valid .docx (missing word/document.xml)');
  const xml = zip.readAsText(entry);
  const bodyM = xml.match(/<w:body[^>]*>([\s\S]*)<\/w:body>/);
  const body = bodyM ? bodyM[1] : xml;

  // Top-level blocks: whole tables OR paragraphs. Tables matched first so their
  // inner paragraphs aren't emitted twice.
  const tokenRe = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g;
  const out = [];
  let m;
  while ((m = tokenRe.exec(body)) !== null) {
    const block = m[0];
    if (block.startsWith('<w:tbl>')) {
      const rows = [...block.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)];
      for (const r of rows) {
        const cells = [...r[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)]
          .map(tc => _runsText(tc[0]).trim());
        if (cells.some(c => c)) out.push('| ' + cells.join(' | ') + ' |');
      }
    } else {
      const line = _runsText(block).trim();
      if (line) out.push(line);
    }
  }
  return out.join('\n');
}

// ── report listing + cache ────────────────────────────────────────
// Cache key: filename + mtimeMs, so a regenerated report is re-read.
const _cache = new Map(); // name -> { mtimeMs, text }

function listReports() {
  let files;
  try {
    files = fs.readdirSync(REPORTS_DIR);
  } catch (e) {
    return { dir: REPORTS_DIR, error: 'Reports folder not found: ' + REPORTS_DIR, reports: [] };
  }
  const reports = files
    .filter(f => f.toLowerCase().endsWith('.docx') && !f.startsWith('~$'))
    .map(f => {
      const st = fs.statSync(path.join(REPORTS_DIR, f));
      return { name: f, size: st.size, modified: st.mtime.toISOString() };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified)); // newest first
  return { dir: REPORTS_DIR, reports };
}

function getReportText(name) {
  // Guard against path traversal — only a bare filename inside REPORTS_DIR.
  const safe = path.basename(name);
  if (safe !== name) throw new Error('Invalid report name');
  const full = path.join(REPORTS_DIR, safe);
  if (!fs.existsSync(full)) throw new Error('Report not found: ' + safe);

  const st = fs.statSync(full);
  const hit = _cache.get(safe);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.text;

  const text = docxToText(full);
  _cache.set(safe, { mtimeMs: st.mtimeMs, text });
  return text;
}

// ── routes ────────────────────────────────────────────────────────
router.get('/reports', (req, res) => {
  res.json(listReports());
});

router.get('/reports/:name/text', (req, res) => {
  try {
    const text = getReportText(req.params.name);
    res.json({ name: req.params.name, chars: text.length, text });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

router.get('/llm/health', async (req, res) => {
  try {
    const r = await fetch(OLLAMA_URL + '/api/tags', { signal: AbortSignal.timeout(2500) });
    const data = await r.json();
    const models = (data.models || []).map(m => m.name);
    res.json({
      available: true,
      url: OLLAMA_URL,
      model: OLLAMA_MODEL,
      model_present: models.some(n => n === OLLAMA_MODEL || n.startsWith(OLLAMA_MODEL.split(':')[0])),
      models,
    });
  } catch (e) {
    res.json({
      available: false,
      url: OLLAMA_URL,
      model: OLLAMA_MODEL,
      message: 'Ollama not reachable. On the host run: ollama serve (and set OLLAMA_HOST=0.0.0.0 so the container can reach it).',
      detail: e.message,
    });
  }
});

// POST /api/llm/chat
//   body: { report: "<filename>", messages: [{role, content}, ...] }
//   The latest user turn is the question; prior turns give follow-up context.
router.post('/llm/chat', async (req, res) => {
  try {
    const { report, messages } = req.body || {};
    if (!report)  return res.status(400).json({ error: 'No report selected' });
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages[] required' });
    }

    let reportText;
    try {
      reportText = getReportText(report);
    } catch (e) {
      return res.status(404).json({ error: e.message });
    }

    let context = reportText;
    let truncated = false;
    if (context.length > MAX_CONTEXT_CHARS) {
      context = context.slice(0, MAX_CONTEXT_CHARS);
      truncated = true;
    }

    const system =
      'You are the Tactix Report Assistant. Answer questions ONLY using the ' +
      'evaluation report provided below. The report contains paragraphs and ' +
      'tables (rows are shown as "| cell | cell |"). If the answer is not in ' +
      'the report, say so plainly — do not invent numbers. Be concise and ' +
      'precise; quote exact figures from the tables when asked.\n\n' +
      '===== REPORT: ' + path.basename(report) + ' =====\n' +
      context +
      (truncated ? '\n\n[Report truncated for length.]' : '') +
      '\n===== END OF REPORT =====';

    const ollamaBody = {
      model: OLLAMA_MODEL,
      stream: false,
      options: { temperature: 0.2 },
      messages: [{ role: 'system', content: system }, ...messages],
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000); // CPU inference can be slow
    let r;
    try {
      r = await fetch(OLLAMA_URL + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ollamaBody),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!r.ok) {
      const err = await r.text();
      return res.status(502).json({ error: 'Ollama error: ' + err });
    }

    const data = await r.json();
    const answer = (data.message && data.message.content) ? data.message.content.trim() : '';
    console.log('  🤖 Report Assistant [' + path.basename(report) + ']: ' +
                (answer.slice(0, 80) || '(empty)'));
    res.json({ answer, model: OLLAMA_MODEL, truncated });
  } catch (e) {
    if (e.name === 'AbortError') {
      return res.status(504).json({ error: 'LLM timeout (120s). gemma3:1b on CPU can be slow on long reports.' });
    }
    res.status(502).json({
      error: 'LLM request failed. Is Ollama running on the host?',
      detail: e.message,
    });
  }
});

module.exports = { router, docxToText, listReports, getReportText };
