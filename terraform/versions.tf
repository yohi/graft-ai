terraform {
  required_version = ">= 1.5.0"

  cloud {
    organization = "y_ohi"
    workspaces {
      name = "graft-ai-cloudflare"
    }
  }

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}
