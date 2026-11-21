# Deploy Agent Army to Google Cloud Run

This tutorial runs `deploy/gcp.sh` from this repository. It creates a private
bucket, two secrets, two service accounts, the web service and the worker job
in a Google Cloud project of yours, then prints the URL and the one-time setup
token. It takes about 15 to 25 minutes, most of it the image build. Sizes and
costs are in the README, under "Deploy anywhere > Google Cloud Run".

## Pick a project

Choose or create a project with billing enabled:

<walkthrough-project-setup billing="true"></walkthrough-project-setup>

This repository opens in a temporary Cloud Shell without your credentials, so
sign in first, then select the project:

```sh
gcloud auth login
gcloud config set project <walkthrough-project-id/>
```

## Deploy

Run the script from the repository folder (the terminal is already there):

```sh
PROJECT=<walkthrough-project-id/> REGION=us-central1 ./deploy/gcp.sh
```

It enables the APIs it needs, builds the image with Cloud Build, and deploys.
It is safe to re-run: it updates in place and keeps the secrets and the data.

## Sign in

Open the URL the script printed and create the admin account with the setup
token it printed. To read the token again:

```sh
gcloud secrets versions access latest --secret agent-army-setup-token --project <walkthrough-project-id/>
```

Then connect Claude, Slack and GitHub on the page.

## Update later

Open this tutorial again (or any Cloud Shell with a clone of the repository),
then:

```sh
git pull
PROJECT=<walkthrough-project-id/> REGION=us-central1 ./deploy/gcp.sh
```

<walkthrough-conclusion-trophy></walkthrough-conclusion-trophy>

Agent Army is running in your project.
