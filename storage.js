'use strict';
// Private file storage through the S3 protocol.
// Works with Supabase Storage today, and with AWS S3 or similar later: only the .env values change.
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const endpoint = process.env.STORAGE_ENDPOINT;
const bucket = process.env.STORAGE_BUCKET;
const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID;
const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY;

const enabled = !!(endpoint && bucket && accessKeyId && secretAccessKey);

const client = enabled
  ? new S3Client({
      endpoint,
      region: process.env.STORAGE_REGION || 'ap-south-1',
      forcePathStyle: true, // Supabase needs this
      credentials: { accessKeyId, secretAccessKey },
      // Some S3-compatible services reject the newer automatic checksums.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    })
  : null;

const put = (key, body, contentType) =>
  client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));

// Returns the S3 response; response.Body is a stream. `range` looks like "bytes=0-999".
const get = (key, range) =>
  client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: range }));

const remove = (key) => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));

module.exports = { enabled, put, get, remove };
