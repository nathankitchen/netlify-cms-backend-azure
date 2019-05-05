# attempt to adapt netlify-cms for dev.azure.com 

WARNING - This option is currently under construction and lightyears away from complete or any PROD use

Feel welcome to contribute


## dev-test/config.yml changes needed to connect to Azure DevOps

backend:
  name: azure
  branch: branch-name
  project: organization-name/project-name
  repo: repo-name
  tenant_id: tenant-id
  app_id: registered-app-id  
  
site_url: "http://localhost:8080"
