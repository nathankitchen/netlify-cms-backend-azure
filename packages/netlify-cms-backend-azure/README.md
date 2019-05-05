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

## general preparations

not specific to this adaption of netlify-cms to dev.azure.com

make sure you have a recent version of node/npm (I used 10.14.2) and that 'yarn' and 'lerna' are installed, too

## prepare for testing / debugging / dev for dev.azure.com

### create an app in AAD (Azure Active Directory)

In case you have 'Azure CLT' (Command Line Tools) installed you should have an 'az' command in the commandline: