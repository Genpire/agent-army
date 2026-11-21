// EXPERIMENTAL, not yet tested on a real Azure subscription: it compiles and
// lints clean, but has never been deployed. Please report what works and what doesn't.
//
// Agent Army (Pointer and its team) on Azure Container Apps: one always-on
// replica with HTTPS ingress, data on an Azure Files share, logs in Log
// Analytics. Repo tasks run as child processes of the server (RUNNER=local).
// Replicas stop at 4 vCPU / 8 GiB: set Settings > Repo task limits > Tasks at
// the same time to 1 or 2.
//
//   az group create --name agent-army --location eastus
//   az deployment group create --resource-group agent-army --template-file deploy/azure/main.bicep \
//     --parameters masterKey="$(openssl rand -hex 32)"
// Keep that master key: every later deployment must pass the same value.
//
// The Deploy to Azure button needs ARM JSON: after editing this file run
//   az bicep build --file deploy/azure/main.bicep --outfile deploy/azure/azuredeploy.json
// and commit both files.

@description('Name of the container app (part of its URL).')
@minLength(2)
@maxLength(32)
param appName string = 'agent-army'

@description('Region for every resource.')
param location string = resourceGroup().location

@description('Container image (linux/amd64). A public image needs no credentials.')
param image string = 'ghcr.io/genpire/agent-army:latest'

@description('Private image only: registry user name, e.g. your GitHub user for ghcr.io. Leave empty for a public image.')
param registryUsername string = ''

@description('Private image only: registry password, e.g. a GitHub token with read:packages.')
@secure()
param registryPassword string = ''

@description('vCPU and memory of the replica. Consumption allows up to 4 vCPU / 8Gi, memory = 2 x vCPU.')
@allowed([
  '2.0/4Gi'
  '3.0/6Gi'
  '4.0/8Gi'
])
param size string = '4.0/8Gi'

// No generated default: ARM would generate a new one on every redeploy, and a new
// key makes the stored data unreadable.
@description('Encrypts the stored config and signs admin sessions. Paste a long random value (openssl rand -hex 32) and keep it: every redeploy must pass the SAME value, or the stored data cannot be read.')
@secure()
@minLength(32)
param masterKey string

@description('One-time token that creates the admin account. Generated if left as is (a new one on each deploy); read it in the container app > Settings > Secrets > setup-token.')
@secure()
param setupToken string = newGuid()

var cpu = json(split(size, '/')[0])
var memory = split(size, '/')[1]
var usePrivateRegistry = !empty(registryPassword)
var registryServer = split(image, '/')[0]
var suffix = uniqueString(resourceGroup().id, appName)

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${appName}-logs-${suffix}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: take('aa${suffix}', 24)
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: 'agent-army-data'
  properties: {
    shareQuota: 100
  }
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${appName}-env'
  location: location
  properties: {
    // A workload-profiles environment: Consumption replicas can have up to 4 vCPU / 8Gi
    // (a Consumption-only environment stops at 2 vCPU / 4Gi).
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

resource envStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: env
  name: 'data'
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: share.name
      accessMode: 'ReadWrite'
    }
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
      }
      secrets: concat([
        { name: 'master-key', value: masterKey }
        { name: 'setup-token', value: setupToken }
      ], usePrivateRegistry ? [
        { name: 'registry-password', value: registryPassword }
      ] : [])
      registries: usePrivateRegistry ? [
        {
          server: registryServer
          username: registryUsername
          passwordSecretRef: 'registry-password'
        }
      ] : []
    }
    template: {
      containers: [
        {
          name: 'agent-army'
          image: image
          resources: {
            cpu: cpu
            memory: memory
          }
          env: [
            { name: 'PORT', value: '8080' }
            { name: 'STORAGE', value: 'fs' }
            { name: 'DATA_DIR', value: '/data' }
            { name: 'RUNNER', value: 'local' }
            { name: 'REQUIRE_MASTER_KEY', value: '1' }
            { name: 'PUBLIC_URL', value: 'https://${appName}.${env.properties.defaultDomain}' }
            { name: 'MASTER_KEY', secretRef: 'master-key' }
            { name: 'SETUP_TOKEN', secretRef: 'setup-token' }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/healthz', port: 8080 }
              periodSeconds: 10
              failureThreshold: 30
            }
            {
              type: 'Liveness'
              httpGet: { path: '/healthz', port: 8080 }
              periodSeconds: 30
            }
          ]
          volumeMounts: [
            { volumeName: 'data', mountPath: '/data' }
          ]
        }
      ]
      // Always on, exactly one replica: per-thread queues, event dedupe and running tasks live in memory.
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
      volumes: [
        {
          name: 'data'
          storageType: 'AzureFile'
          storageName: envStorage.name
          // The image runs as node (1000:1000).
          mountOptions: 'uid=1000,gid=1000,dir_mode=0750,file_mode=0640,mfsymlinks,nobrl'
        }
      ]
    }
  }
}

output url string = 'https://${app.properties.configuration.ingress.fqdn}'
output setupTokenHint string = 'Container app > Settings > Secrets > setup-token'
