# Monet Foundry agent

Paste **`foundry-agent-instructions-Monet.txt`** into the Azure AI Foundry agent instructions for Monet (single agent).

## App settings (ora-buddy-api / SWA)

Preferred:

```
BUDDY_FOUNDRY_PROJECT_ENDPOINT=...
BUDDY_FOUNDRY_API_KEY=...
BUDDY_FOUNDRY_AGENT_NAME=Monet
BUDDY_DISPLAY_NAME=Monet
```

Legacy `FOUNDRY_*` / `BudgetBuddy` / `BudgetBuddy2` names still resolve if set.

Data Lens keeps separate `FOUNDRY_*` / Lens credentials — do not point Lens at Monet’s Claude project.
