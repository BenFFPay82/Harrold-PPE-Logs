# Harrold PPE Logs

Web application for Harrold Community Fire Station to digitise monthly PPE inspection records.

## Overview

Replaces paper-based PPE inspection books with a mobile-friendly web app. 10 firefighters, each with ~13 items of personally-assigned kit, must confirm monthly that their gear is in good condition.

## Requirements

### Users
- 10 firefighters at Harrold station
- No authentication required — open access via station link or QR code
- Mobile-first (crew use personal phones)

### Equipment per person (13 items)
| Type | Qty | Notes |
|------|-----|-------|
| Fire tunic | 2 | Gold PBI Titan coat |
| RTC tunic | 1 | Hi-vis yellow coat |
| Fire gloves | 2 | XFS firefighter gloves |
| RTC gloves | 1 | Orange rescue gloves |
| Leggings/trousers | 2 | Gold PBI Titan trousers |
| Fire boots | 2 | Structural leather boots |
| Helmet | 1 | Heros Titan |
| Fire hood | 2 | RIB PBI Gold hood |
| Half-mask respirator | 1 | (if assigned) |
| BA mask | 1 | (if assigned) |

Each item has a unique barcode from Bristol Uniforms.

### Monthly check workflow
1. Firefighter opens app (link or QR scan)
2. Selects their name from list
3. Sees their assigned kit (populated from Bristol data)
4. Marks each item: **Good** or **Defect**
5. If defect: add note (optional photo)
6. Submits — timestamp recorded

### Notifications
- **Instant email** when any defect is logged → ben.paynter@bedsfire.gov.uk
- **Weekly digest** every Monday morning → summary of all checks done + outstanding
- **End of month reminder** → email if anyone hasn't completed their monthly check

### Dashboard (WM view)
- Shows all 10 crew
- For each: last check date, status (complete/incomplete), any open defects
- Filter by month
- Quarterly audit view: confirm all crew completed checks for Q1/Q2/Q3/Q4

### Historical view
- View any previous month's checks
- See who checked, when, and what they reported
- Audit trail for HMICFRS compliance

## Data model

### Firefighter
```
id: string (primary key)
name: string
employee_no: string (from Bristol CSV)
```

### Equipment
```
barcode: string (primary key, from Bristol "Product ID")
type: string (fire_tunic | rtc_tunic | fire_gloves | rtc_gloves | trousers | boots | helmet | hood | half_mask | ba_mask)
description: string (from Bristol "Garment Details")
size: string
firefighter_id: string (foreign key)
```

### MonthlyCheck
```
id: string (primary key)
firefighter_id: string (foreign key)
month: string (YYYY-MM)
completed_at: datetime
```

### ItemCheck
```
id: string (primary key)
monthly_check_id: string (foreign key)
barcode: string (foreign key to Equipment)
condition: string (good | defect)
notes: string (optional)
photo_url: string (optional)
checked_at: datetime
```

### Audit
```
id: string (primary key)
quarter: string (e.g. "2026-Q1")
audited_by: string
audited_at: datetime
notes: string (optional)
```

## CSV import

Bristol exports one CSV per firefighter. Structure:

```
"Employee No","Employee Name","Location","Product ID","Garment Details","Size","Fit","Date Manufactured","Product Code","Current Condition","Previous Condition Code","Service Date","Service History"
```

**Import rules:**
- Only import rows where **Location** contains "HARROLD" (filter out Bedford, Dunstable, etc.)
- Only import rows where **Employee No** is populated (skip service history continuation rows)
- **Product ID** = barcode
- **Garment Details** = description
- Map to equipment type based on Garment Details keywords:
  - "COAT" + "GOLD PBI" → fire_tunic
  - "COAT" + "HI VIS" → rtc_tunic
  - "TROUSER" → trousers
  - "FIRE FIGHTER GLOVE" → fire_gloves
  - "RESCUE GLOVE" → rtc_gloves
  - "BOOT" → boots
  - "HOOD" → hood
  - "HEL" or "HELMET" → helmet

## Tech stack

- **Frontend**: HTML/CSS/JS, mobile-first, single page app
- **Backend**: Node.js + Express (or Python Flask — developer choice)
- **Database**: SQLite (file-based, simple deployment)
- **Email**: Nodemailer with SMTP (or SendGrid/Resend for reliability)
- **Hosting**: Vercel, Render, or Railway (free tier)

## File structure

```
/
├── README.md
├── package.json
├── server.js (or app.py)
├── database.sqlite
├── /public
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── /scripts
│   └── import-csv.js (one-time import from Bristol CSVs)
├── /data
│   └── (Bristol CSV files for import)
└── /uploads
    └── (defect photos)
```

## API endpoints

```
GET  /api/firefighters              — list all firefighters
GET  /api/firefighters/:id/equipment — list equipment for one firefighter
GET  /api/firefighters/:id/checks    — list monthly checks for one firefighter
POST /api/checks                     — submit a monthly check
GET  /api/dashboard                  — summary for WM dashboard
GET  /api/dashboard/:month           — summary for specific month
POST /api/audits                     — record quarterly audit sign-off
```

## Email configuration

Environment variables:
```
EMAIL_HOST=smtp.example.com
EMAIL_PORT=587
EMAIL_USER=...
EMAIL_PASS=...
EMAIL_TO=ben.paynter@bedsfire.gov.uk
```

## Development

```bash
# Install dependencies
npm install

# Import Bristol CSVs (one-time)
node scripts/import-csv.js ./data/*.csv

# Run locally
npm run dev

# Deploy
# (Configure for chosen platform)
```

## Notes

- No login required — station-only access assumed
- QR code for quick mobile access (generate and print for appliance bay)
- All times in UK timezone (Europe/London)
- Data retention: keep indefinitely for audit purposes
