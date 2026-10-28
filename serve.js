'use strict';
// Sends one stored photo or video to the browser. The caller must already have checked
// that this person is allowed to see it. Supports "Range" so videos can skip ahead.
const path = require('path');
const { pipeline } = require('stream/promises');
const storage = require('./storage');
const { fail } = require('./lib');

async function sendMedia(req, res, row, which) {
  if (!storage.enabled) {
    return fail(res, 503, 'File storage is not set up yet. Ask the site owner to finish "Photos and videos" in the README.');
  }
  const thumb = which === 'thumb';
  if (thumb && !row.thumb_key) return fail(res, 404, 'Not found');
  const range = !thumb && /^bytes=\d*-\d*$/.test(req.headers.range || '') ? req.headers.range : undefined;
  let obj;
  try {
    obj = await storage.get(thumb ? row.thumb_key : row.object_key, range);
  } catch (e) {
    const status = e.$metadata && e.$metadata.httpStatusCode;
    if (status === 404) return fail(res, 404, 'Not found');
    if (status === 416) { res.setHeader('Content-Range', 'bytes */' + row.size_bytes); return fail(res, 416, 'Bad range'); }
    throw e;
  }
  const ext = path.extname(row.object_key);
  res.status(obj.$metadata.httpStatusCode === 206 ? 206 : 200);
  res.setHeader('Content-Type', thumb ? 'image/jpeg' : row.content_type);
  res.setHeader('Accept-Ranges', 'bytes');
  if (obj.ContentLength != null) res.setHeader('Content-Length', String(obj.ContentLength));
  if (obj.ContentRange) res.setHeader('Content-Range', obj.ContentRange);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Content-Disposition', req.query.download === '1' ? `attachment; filename="matrix-${row.kind}-${row.id}${ext}"` : 'inline');
  try { await pipeline(obj.Body, res); } catch { /* the browser closed the page or stopped the video */ }
}

module.exports = { sendMedia };
