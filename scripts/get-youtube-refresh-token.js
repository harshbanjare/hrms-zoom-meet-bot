const http = require("http");
const axios = require("axios");

const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const PORT = Number(process.env.OAUTH_PORT || 3000);
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth2callback`;
const SCOPE = "https://www.googleapis.com/auth/youtube.upload";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing YOUTUBE_CLIENT_ID or YOUTUBE_CLIENT_SECRET");
  process.exit(1);
}

function buildAuthUrl() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: SCOPE,
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const params = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  });

  const response = await axios.post(
    "https://oauth2.googleapis.com/token",
    params.toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 15000,
    }
  );

  return response.data;
}

console.log("\nOpen this URL in your browser and sign in with the YouTube channel account:\n");
console.log(buildAuthUrl());
console.log(`\nWaiting for OAuth callback on ${REDIRECT_URI}...\n`);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, REDIRECT_URI);

    if (url.pathname !== "/oauth2callback") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");

    if (error) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end(`OAuth error: ${error}`);
      console.error("OAuth error:", error);
      server.close(() => process.exit(1));
      return;
    }

    if (!code) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing code");
      console.error("Missing authorization code");
      server.close(() => process.exit(1));
      return;
    }

    const tokens = await exchangeCodeForToken(code);

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OAuth complete. Check your terminal for the refresh token.");

    console.log("\nTokens:\n");
    console.log(JSON.stringify(tokens, null, 2));

    if (!tokens.refresh_token) {
      console.error(
        "\nNo refresh_token was returned. Revoke the app at https://myaccount.google.com/permissions and try again."
      );
      server.close(() => process.exit(1));
      return;
    }

    console.log(`\nYOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    server.close(() => process.exit(0));
  } catch (error) {
    console.error(error);
    try {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to exchange the authorization code.");
    } catch (_ignored) {
      // no-op
    }
    server.close(() => process.exit(1));
  }
});

server.listen(PORT, "127.0.0.1");
