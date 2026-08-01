File JSON di folder ini isinya daftar perubahan sel Sheets yang MAU dikirim. Ditulis di sini &
di-push HANYA SETELAH Denny konfirmasi eksplisit di chat - bukan otomatis. Format tiap file:

{
  "spreadsheetId": "...",
  "sheetName": "...",
  "matchColumn": "F",
  "writeColumn": "G",
  "headerRow": 1,
  "updates": [ { "matchValue": "1346", "value": 95000 }, ... ]
}
