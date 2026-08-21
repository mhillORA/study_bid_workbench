# Deploy Buddy Function App from GitHub (optional)

Manual deploy (VS Code / zip / `func publish`) is fine. Use this only if you want CI.

1. Function App → **Get publish profile** → download `.PublishSettings`  
2. GitHub repo → **Settings** → **Secrets and variables** → **Actions**  
3. New secret name: `AZURE_FUNCTIONAPP_PUBLISH_PROFILE`  
4. Paste entire publish profile XML  
5. Uncomment / enable the workflow `.github/workflows/buddy-function-app.yml` if present  

Until that secret exists, the workflow should stay disabled or it will fail.
