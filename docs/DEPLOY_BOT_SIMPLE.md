# How to deploy the bot (simple, foolproof)

The WhatsApp bot runs on **Google Apps Script**. Changing the code is **2 actions**:
**(1) Save the new code**, then **(2) update the EXISTING deployment to a new version.**

> ⚠️ The #1 mistake: clicking **"New deployment"**. That creates a *brand-new URL*
> that WhatsApp does NOT use, so nothing changes. You must **edit the deployment
> you already have** and bump it to a new version. Same URL, new code.

---

## Step 1 — Paste + SAVE the code
1. Go to **script.google.com** and open your **Kesefle** bot project.
2. In the file list (left), open the main code file (`Code.gs` / `ExpenseBot`).
3. Select all (Ctrl+A / Cmd+A), delete, and paste the full contents of
   `bot/ExpenseBot_DEPLOY.gs`.
4. Press **Ctrl+S** (Windows) / **Cmd+S** (Mac) to **Save**. Wait for "Saved".

## Step 2 — Add the Gemini key (only once)
1. Left sidebar → click the **gear ⚙️ "Project Settings"**.
2. Scroll to **"Script Properties"**.
3. If there is no row named **`GEMINI_API_KEY`**, click **"Add script property"**:
   - Property: `GEMINI_API_KEY`
   - Value: *(your Gemini key from aistudio.google.com)*
   - Click **Save**.

## Step 3 — Deploy a NEW VERSION (the important part)
1. Top-right → click **Deploy** → **Manage deployments**.
2. You'll see your existing deployment. Click the **pencil ✏️ (Edit)** on it.
   *(Do NOT click "New deployment".)*
3. Find the **"Version"** dropdown → choose **"New version"**.
4. Click **Deploy**, then **Done**.

## Step 4 — Test
1. WhatsApp the bot and send: **`אני רוצה סיכום`**
2. ✅ It replies with a summary (not "לא הבנתי").
3. Also try: **`אפשר להוסיף קטגוריה?`** → should give a real answer.

---

## If it STILL says "לא הבנתי"
- Re-check Step 2: the property must be named exactly `GEMINI_API_KEY` (no spaces),
  and the value must be the real key.
- Re-check Step 3: you edited the **existing** deployment to **New version**
  (not created a new deployment).
- Confirm you pasted into the file that the webhook actually runs (the one with
  `doPost`). Search the code for `doPost` — it must be there.

## Where the webhook lives (for reference)
- The WhatsApp webhook in Meta points to your Apps Script **Web App `/exec` URL**.
- That URL only ever runs the **last deployed version** — which is why Step 3 matters.
- Saving (Step 1) alone never changes what `/exec` runs.
