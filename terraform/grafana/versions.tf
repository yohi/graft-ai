terraform {
  required_version = ">= 1.5.0"

  cloud {
    organization = "graft-ai"
    workspaces {
      name = "graft-ai-grafana"
    }
  }

  required_providers {
    grafana = {
      source  = "grafana/grafana"
      version = "~> 3.0"
    }
  }
}
