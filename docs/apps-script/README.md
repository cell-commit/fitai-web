# Deploy the FitAI ⇄ Google Drive sync bridge

This is a one-time setup (about 10 minutes). It creates a tiny Google
Apps Script "web app" that lets the FitAI web app read and update your
three training files on Google Drive:

- `training-status.md`
- `training-history-log.md`
- `CLAUDE.md`

These live in **My Drive → AI → AI Context Vault → Training** — the same
files your Claude Code `training` skill uses. The script runs **as you**,
so it has your normal Drive access; a secret token is the only thing that
lets the app in.

You don't need to be a developer. Follow the steps in order.

---

## Step 1 — Create the script project

1. Go to <https://script.google.com> (sign in with the same Google
   account that owns the Drive files).
2. Click **New project** (top left).
3. You'll see a code editor with a file called `Code.gs` containing a
   sample `myFunction`. Select **all** of that sample code and delete it.
4. Open `Code.gs` from this folder (`docs/apps-script/Code.gs` in the
   FitAI repo), copy its entire contents, and paste them into the editor.
5. Give the project a name (click "Untitled project" at the top), e.g.
   **FitAI Drive Bridge**.

---

## Step 2 — Find your Training folder ID

1. Open <https://drive.google.com> in a browser.
2. Navigate to **AI → AI Context Vault → Training** and open that folder
   (double-click it so it's the folder you're inside).
3. Look at the browser address bar. The URL looks like:

   ```
   https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456
   ```

   The long string after `/folders/` is the **folder ID**. Copy it
   (everything after the last `/`, before any `?`).

4. Back in the script editor, find this line near the top:

   ```js
   const FOLDER_ID = 'PASTE_FOLDER_ID_HERE';
   ```

   Replace `PASTE_FOLDER_ID_HERE` with the ID you copied (keep the
   quotes).

---

## Step 3 — Create a secret token

You need a long random string that only you and the app know. It must be
40+ characters. Any of these works:

- **Mash the keyboard**: type 40+ random letters and numbers, no spaces.
- **Terminal (Mac)**: run this and copy the output:

  ```bash
  openssl rand -hex 32
  ```

  (that gives you a 64-character hex string — perfect.)

In the script editor, find:

```js
const TOKEN = 'PASTE_LONG_RANDOM_TOKEN_HERE';
```

Replace `PASTE_LONG_RANDOM_TOKEN_HERE` with your token (keep the quotes).
**Keep a copy** — you'll paste the same string into the app in Step 6.

Then click the **Save** icon (💾) in the toolbar.

---

## Step 4 — Deploy as a web app

1. Click the blue **Deploy** button (top right) → **New deployment**.
2. Click the gear icon next to "Select type" → choose **Web app**.
3. Fill in the deployment settings:
   - **Description**: `FitAI bridge` (anything is fine).
   - **Execute as**: **Me** (your email).
   - **Who has access**: **Anyone with the link**.

   > "Anyone with the link" sounds scary, but the link alone does
   > nothing — every request must also carry your secret token, and the
   > script only ever touches the three named files.

4. Click **Deploy**.

---

## Step 5 — Authorize the permissions prompt

The first deployment asks for permission (this is Google confirming
*you* allow the script to use *your* Drive):

1. Click **Authorize access**.
2. Choose your Google account.
3. You may see **"Google hasn't verified this app"** — this is normal for
   your own scripts. Click **Advanced**, then
   **Go to FitAI Drive Bridge (unsafe)**.
4. Review the access (it asks to see/manage your Drive files) and click
   **Allow**.

After authorizing, you'll get a **Web app URL** ending in `/exec`, e.g.:

```
https://script.google.com/macros/s/AKfyc...long.../exec
```

Click **Copy** to copy it.

---

## Step 6 — Connect the app

1. In **FitAI**, open **More → Settings**.
2. Under **Drive Sync**, paste:
   - **Apps Script URL** → the `/exec` URL from Step 5.
   - **Sync Token** → the exact token string from Step 3.
3. Click **Save Settings**.
4. Click **Test connection**.

You should see the three files listed with their last-modified times. If
you get an error, see Troubleshooting below.

---

## Redeploying after you edit the script

If you ever change `Code.gs` (or the token/folder ID inside it), the live
web app does **not** update automatically. You must publish a new version:

1. Save the script (💾).
2. **Deploy → Manage deployments**.
3. Click the pencil (**Edit**) on the existing deployment.
4. Under **Version**, choose **New version**.
5. Click **Deploy**.

The `/exec` URL stays the same, so you don't need to re-paste it in the
app — as long as you edited the existing deployment (not created a brand
new one). If you create a *new* deployment instead, you'll get a new URL
and must update it in Settings.

---

## Rotating the token (if it ever leaks)

1. Generate a new token (Step 3).
2. Replace the `TOKEN` value in `Code.gs`, save.
3. Redeploy a new version (see above).
4. Update **Sync Token** in FitAI Settings to match.

The old token stops working immediately once the new version is live.

---

## Troubleshooting

- **"unauthorized"** — the token in the app doesn't match the `TOKEN` in
  the script. Re-copy it carefully (no leading/trailing spaces).
- **"File not found in folder"** — the `FOLDER_ID` is wrong, or a file
  name doesn't match exactly. The files must be named
  `training-status.md`, `training-history-log.md`, and `CLAUDE.md` and
  live directly in the Training folder.
- **A network / "could not reach" error** — the URL is wrong or the
  deployment was removed. Confirm the URL ends in `/exec` and that the
  deployment still exists under Manage deployments.
- **Nothing happens for a few seconds** — Apps Script "cold starts" can
  take 1–3 seconds on the first request. That's normal; the app queues
  writes in the background so it never blocks you at the gym.
