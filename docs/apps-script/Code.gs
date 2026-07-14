/**
 * FitAI ⇄ Google Drive sync bridge (Google Apps Script web app).
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  FILL IN THESE TWO CONSTANTS BEFORE DEPLOYING.                       │
 * │  Step-by-step instructions are in README.md next to this file.      │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 *   FOLDER_ID — the Drive ID of the "AI Context Vault/Training" folder.
 *     Open that folder in drive.google.com; the ID is the last path
 *     segment of the URL:
 *       https://drive.google.com/drive/folders/1AbCdEf...XyZ
 *                                               └──── this part ────┘
 *
 *   TOKEN — a long random shared secret (40+ chars). The exact same
 *     string is pasted into FitAI → Settings → Sync Token. Anyone with
 *     this token + the web-app URL can read/write the three files, so
 *     keep it private. To rotate it: change it here, redeploy a new
 *     version (see README), and update it in the app.
 *
 * This script executes as YOU ("Execute as: Me") so it has your normal
 * Drive access; the token is the only gate. Only the three ALLOWED file
 * names can ever be touched, and only within FOLDER_ID.
 */

const FOLDER_ID = 'PASTE_FOLDER_ID_HERE';
const TOKEN = 'PASTE_LONG_RANDOM_TOKEN_HERE';

// The only files this bridge will ever read or write.
const ALLOWED = ['training-status.md', 'training-history-log.md', 'CLAUDE.md'];

// Sentinel filename for the "list all files" mode used by Test connection.
const LIST_SENTINEL = '__list__';

/**
 * GET handler.
 *   ?token=..&file=training-status.md   → { name, content, modifiedTime }
 *   ?token=..&file=__list__             → { files: [{ name, modifiedTime }, ...] }
 */
function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    if (params.token !== TOKEN) return jsonOut({ error: 'unauthorized' });

    const name = params.file;

    // List mode — used by the app's "Test connection" button.
    if (name === LIST_SENTINEL) {
      const files = ALLOWED.map(function (fname) {
        try {
          const f = getFileByName(fname);
          return { name: fname, modifiedTime: f.getLastUpdated().toISOString() };
        } catch (err) {
          return { name: fname, error: String(err && err.message ? err.message : err) };
        }
      });
      return jsonOut({ files: files });
    }

    if (ALLOWED.indexOf(name) === -1) return jsonOut({ error: 'forbidden' });

    const f = getFileByName(name);
    return jsonOut({
      name: name,
      content: f.getBlob().getDataAsString('UTF-8'),
      modifiedTime: f.getLastUpdated().toISOString(),
    });
  } catch (err) {
    return jsonOut({ error: String(err && err.message ? err.message : err) });
  }
}

/**
 * POST handler. Body (JSON, sent as text/plain):
 *   { token, file, op: 'write'|'append', content, baseModifiedTime? }
 *
 * 'write' with a baseModifiedTime older than the server's copy → returns
 *   { error: 'conflict', modifiedTime, content } so the client can rebase.
 * 'append' never conflicts; the server normalizes trailing whitespace to a
 *   single blank line before appending.
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.token !== TOKEN) return jsonOut({ error: 'unauthorized' });
    if (ALLOWED.indexOf(body.file) === -1) return jsonOut({ error: 'forbidden' });
    if (body.op !== 'write' && body.op !== 'append') {
      return jsonOut({ error: 'bad_request', message: 'op must be write or append' });
    }

    lock.waitLock(10000);

    var f = getFileByName(body.file);
    var serverMtime = f.getLastUpdated().toISOString();

    // Conflict check only applies to full overwrites. Appends are always safe.
    if (
      body.op === 'write' &&
      body.baseModifiedTime &&
      serverMtime > body.baseModifiedTime
    ) {
      return jsonOut({
        error: 'conflict',
        modifiedTime: serverMtime,
        content: f.getBlob().getDataAsString('UTF-8'),
      });
    }

    var current = f.getBlob().getDataAsString('UTF-8');
    var next;
    if (body.op === 'append') {
      // Collapse trailing whitespace to exactly one blank line, then append.
      next = current.replace(/\s*$/, '\n\n') + body.content;
    } else {
      next = body.content;
    }

    f.setContent(next);

    return jsonOut({ ok: true, modifiedTime: f.getLastUpdated().toISOString() });
  } catch (err) {
    return jsonOut({ error: String(err && err.message ? err.message : err) });
  } finally {
    try {
      lock.releaseLock();
    } catch (ignore) {}
  }
}

/** Find an allowed file by name within FOLDER_ID. Throws if not found. */
function getFileByName(name) {
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var it = folder.getFilesByName(name);
  if (it.hasNext()) return it.next();
  throw new Error('File not found in folder: ' + name);
}

/** Serialize an object as a JSON HTTP response. */
function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
