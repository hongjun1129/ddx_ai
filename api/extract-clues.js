import { handleExtractClues } from "../server.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    await handleExtractClues(req, res);
  } catch (error) {
    console.error(error);
    if (!res.writableEnded) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }
}
