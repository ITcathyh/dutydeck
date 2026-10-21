# Private report export

Install this trusted JavaScript example with `dutydeck plugin install ./examples/plugins/private-export` and set its private report source with `dutydeck plugin config private-export source_url --value-fd 0`. The source endpoint `<source_url>/<reportId>` must return the report bytes. The report body never belongs in tool arguments. Restart the isolated daemon after installing/configuring a plugin.

Set the bot's existing `webBaseUrl` to the HTTPS Web instance sharing its database. Enable Feishu/Lark web login for that same application and allow exactly `<webBaseUrl>/api/plugin-results/oauth/callback` as its redirect URI. No offline access or business-resource scope is requested. Production OAuth/redirect setup is an operator action and is not performed by this example.

During an active human Feishu request, the Agent uses the mandatory turn token from its current prompt:

```sh
dutydeck plugin-tool list --turn "$TURN"
dutydeck plugin-tool call private-export/export-report --json '{"reportId":"weekly"}' --call-id weekly-export-1 --turn "$TURN"
```

A retry keeps the same call ID and arguments. The model sees only delivery ID, status, and file count. Open the host receipt link and sign in using the original requester's account in the original bot application; forwarded links do not grant access. Files are attachments; viewing requires a separate 30 minute browser session. Results expire after 24 hours. Automated, bot-originated, and Web owner requests are rejected.

Fixed limits: 8 files per call, 10 MiB per file, 32 MiB per call, 128 MiB per requester and 1 GiB total unexpired storage; 1 export per requester and 4 globally; 60 second timeout. Interrupted execution is never automatically repeated. Receipt recovery uses the same provider UUID within one hour, then reports unknown delivery. This controls the host API data path, not malicious trusted plugins or another process running as the same OS user.
