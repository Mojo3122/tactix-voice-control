docker start valkey
docker start tactix-age

Write-Host "Waiting for AGE to start..." -ForegroundColor Cyan
Start-Sleep -Seconds 4

$env:DATABASE_URL = "postgresql://postgres:tds25@localhost:5432/tactix_mct"
node server/index.js