# REA browser verification (our own app only)

[REA](https://github.com/morluto/rea) (MIT, npm `rea-agents`) is used **only** against this app on localhost. Never point it at third-party sites.

```bash
npm run build
SESSION_SECRET=$(openssl rand -hex 24) INVITE_ONLY=1 MOCK_PROVIDER=1 PAI_ALLOW_MOCK_PROVIDER=1 PORT=3000 npm start &
npx -y rea-agents capture-browser-scenario tests/e2e/rea-own-app-scenario.json --json > /tmp/rea-capture.json
node tests/e2e/check-rea-capture.mjs /tmp/rea-capture.json
```
Set `executable_path` in the scenario to your Chrome/Chromium.

What the checker asserts:
- every step completed: TEE badge, Verify enclave → "Verified enclave", persona, chat, "signature matches the enclave's reported key · chain not verified" (never "signed by enclave" while the chain is unverified), encrypted backup export and verify
- the browser contacted only our origin
- the canary prompt appears only in the request body of `POST /api/chat`
- localStorage holds only `pai.*` keys

Also check that the canary never appears in the server log: `grep -c REA-CANARY server.log` must print `0`.
