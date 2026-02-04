---
description: Deploy to Dev/Staging/Production Vault
---

# Deploy to Dev/Staging Vault

Use this workflow when testing features in isolated vaults.

## Environments

| Target | Path | Use Case |
|--------|------|----------|
| **test** | `C:\Quest-Board-Test-Vault\` | Isolated testing, safe to break |
| **staging** | `C:\Quest-Board-Staging-Vault\Staging Vault\` | Real files/settings, pre-production |
| **production** | Google Drive vault | Brad's main vault (requires confirmation) |

## Steps

// turbo
1. Build and deploy to **test** vault:
```bash
npm run deploy:test
```

// turbo
2. Or deploy to **staging** vault (real files, pre-production):
```bash
npm run deploy:staging
```

3. Open the target vault in Obsidian and test your changes

4. If changes work, get Brad's approval before deploying to production

// turbo
5. Deploy to **production** vault (ONLY after approval):
```bash
npm run deploy:production
```

## Notes

- **NEVER deploy to production** without Brad's explicit approval
- **Staging** uses real vault files - ideal for final validation before production
- **Test** vault is isolated - break things freely!
