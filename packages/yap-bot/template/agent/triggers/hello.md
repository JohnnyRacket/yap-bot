---
webhook: true
announce: true
# callers send "Authorization: Bearer <YAP_HOOK_SECRET>" (set it in .env); unset, the webhook refuses every request
secret_env: YAP_HOOK_SECRET
---
Someone pressed the hello button.
