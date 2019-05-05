# attempt to adapt netlify-cms for dev.azure.com 

WARNING - This option is currently under construction and lightyears away from complete or any PROD use

Feel welcome to contribute


## dev-test/config.yml changes needed to connect to Azure DevOps

```
backend:
  name: azure
  branch: branch-name
  project: organization-name/project-name
  repo: repo-name
  tenant_id: tenant-id
  app_id: registered-app-id  
  
site_url: "http://localhost:8080"
```
* name - just the string 'azure' to indicate the backend package and API
* branch - usually 'master' - don't change unless you know exactly what you are doing
* project - needs to be adapted from your setting, e.g. if your instance is https://dev.azure.com/coolcompany and within you have a project 'mytechblog' then it is 'coolcompany/mytechblog'
* repo - is usually also 'mytechblog' as by default, the repo has the same name as the project - but it is possible to have multiple repos in one project - in this case you might have a different name here 
* tenant_id and app_id - follow the instructions below to create an app in AAD, then add these parameters here


## general preparations

not specific to this adaption of netlify-cms to dev.azure.com

make sure you have a recent version of node/npm (I used 10.14.2) and that 'yarn' and 'lerna' are installed, too

## prepare for testing / debugging / dev for dev.azure.com

### create an app in AAD (Azure Active Directory)

In case you have 'Azure CLT' (Command Line Tools) installed you should have an 'az' command in the commandline:

```
az --version
```
will output a list of installed submodules with its version information so you know Azure Tools are installed correctly - 

please use your favorite search engine in case it isn't - where to download and how to install - and then how to prepare for its first use: 

```
az login

```
require to enter your Azure username and password - same that you use for https://portal.azure.com and https://dev.azure.com - both have forever free options as of this writing).

### create a service principal for your app
```
az ad sp create-for-rbac --name somename --password somepassword 

```

for example:
```
az ad sp create-for-rbac --name netlifycms001 --password smcyfilten 

```
please pay attention to this output - should look like this:

```
{ 
  "appId": "5d5d5d5d-eeee-4444-aaaa-ffffffffffff", 
  "displayName": "netlifycms001", 
  "name": "http://netlifycms001", 
  "password": "smcyfilten", 
  "tenant": "71717171-3333-4545-bbbb-999999999999" 
}  

```
here we find the appId and tenant_id we need for the config.yml - but hold on, we are no done yet

### change the app settings to allow creation of tokens

take your appId from above and issue this command:


```
az ad app update --id=5d5d5d5d-eeee-4444-aaaa-ffffffffffff  --oauth2-allow-implicit-flow=true --reply-urls="http://localhost:8080"
```
there is no output expected

you may want to add more reply-urls when you deploy netlify-cms to a real website - that's no problem you can have a list here - or even remove localhost:8080 if this app is not used for development (which is recommended).

### allow API usage for dev.azure.com

there is even another step required to allow that this app is allowed to make API calls to dev.azure.com API (aka VSTS API). Unfortunately I haven't found any commandline options yet - so you have to login into https://portal.azure.com, go to AAD, find your app, choose 'enterprise', and add vso.write

TODO - add screenshots here and rework description

...