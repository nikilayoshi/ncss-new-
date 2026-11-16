# 🔬 Science Day 2026 - Student Pass & Hall Attendance System

A lightweight, high-performance web application designed for school Science Day exhibitions. It generates **400 unique printable QR passes into a single PDF** and provides an ultra-fast **Camera Scanner** for phones and laptops to record student entry, bind student names to passes, and prevent duplicate hall entries.

---

## 🌟 Key Features

1. **🎟️ 400 Unique QR Passes in One PDF**:
   - Single-click generation of all 400 passes (`SCI-0001` to `SCI-0400`).
   - Clean 8-badges-per-A4 sheet format with dashed scissor cut lines.
   - Ready to print on standard A4 paper or cardstock.

2. **📱 Mobile & Laptop Camera Scanner**:
   - Real-time in-browser camera scanner (works on Android Chrome, iOS Safari, or Laptop webcams).
   - Audio feedback synthesizer (crystal chime on success, double buzzer on duplicate entry).
   - Barcode scanner gun & manual keyboard typing support.

3. **📝 On-the-Fly Student Registration**:
   - When an unassigned QR badge is scanned at the entrance gate for the first time, a quick popup appears asking for:
     - **Student Name** (e.g. Kasun Fernando)
     - **Class / Grade / School** (e.g. Grade 11-A)
     - Index No / Contact No (optional)
   - Once saved, that QR code is **permanently bound** to that student!

4. **⚠️ Duplicate Scan Prevention**:
   - If a student tries to reuse a pass, or a card is scanned a second time:
     - Flashes a prominent warning: `⚠️ ALREADY INSIDE! Originally entered at 08:35 AM`.
     - Displays total scan count and original entry timestamp.
     - Protects against duplicate entries and ticket sharing.

5. **📊 Live Hall Occupancy Dashboard**:
   - Real-time statistics: Total Passes, Registered, In Hall Now, Duplicate Alerts.
   - Live occupancy progress bar.
   - Real-time activity stream of every scan event.

6. **📁 Excel / CSV Export**:
   - Export full attendance list with one click, including student name, class, check-in status, and exact timestamps.

7. **⚡ Zero External Database Installation**:
   - Uses Node.js built-in `node:sqlite` synchronous database stored in `data/scienceday.db`.
   - Ultra-fast, persistent, and zero configuration needed.

---

## 🚀 How to Run

### Step 1: Start the Server
Double-click `run.bat` or run in terminal:
```bash
npm start
```

### Step 2: Open on Laptop
Open your web browser and go to:
- **`http://localhost:3000`**

### Step 3: Connect Mobile Phones via Local Wi-Fi / Hotspot
1. Connect your laptop and phone to the **same Wi-Fi router** or turn on your laptop's / phone's **Mobile Hotspot**.
2. Open the **"Phone Connect"** tab on your laptop screen.
3. Point your phone camera at the on-screen QR code or open:
   - **`https://<YOUR-LAPTOP-IP>:3443`**
4. On your phone, tap **Advanced &rarr; Proceed** (to accept the local camera security certificate).
5. Start scanning cards directly with your phone camera!

---

## 🖨️ Printing the 400 Badges

1. Go to the **"Print Passes"** tab in the web app.
2. Click **"Download 400 Passes (PDF File)"** to get a 50-page PDF with 8 badges per page.
3. Or click **"Open Browser Print Preview"** to preview the full grid in Chrome and press `Ctrl + P` to print.
