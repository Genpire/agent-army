{{- define "agent-army.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "agent-army.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "agent-army.labels" -}}
{{ include "agent-army.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "agent-army.secretName" -}}
{{- .Values.existingSecret | default (include "agent-army.fullname" .) -}}
{{- end -}}

{{- define "agent-army.publicUrl" -}}
{{- if .Values.publicUrl -}}
{{- .Values.publicUrl | trimSuffix "/" -}}
{{- else if and .Values.ingress.enabled .Values.ingress.host -}}
{{- printf "https://%s" .Values.ingress.host -}}
{{- end -}}
{{- end -}}
