# Monet Foundry agent

Paste **`foundry-agent-instructions-Monet.txt`** into the Azure AI Foundry agent instructions for Monet (single agent).

Site feasibility leave-behinds follow **`docs/feasibility-report-model-instructions.md`** (runtime condensed as `api/src/oraFeasibilityReportContext.txt`). Re-paste Foundry instructions after updating the Monet txt.

## App settings (ora-buddy-api / SWA)

Preferred:

```
BUDDY_FOUNDRY_PROJECT_ENDPOINT=...
BUDDY_FOUNDRY_API_KEY=...
BUDDY_FOUNDRY_AGENT_NAME=Ora-Claude
BUDDY_DISPLAY_NAME=Monet
```

- **Display name** (UI / self-intro): Monet  
- **Foundry agent id**: `Ora-Claude`  

Legacy `FOUNDRY_*` / `BudgetBuddy` / `BudgetBuddy2` names still resolve if set.

Data Lens keeps separate `FOUNDRY_*` / Lens credentials — do not point Lens at Monet’s Claude project.
