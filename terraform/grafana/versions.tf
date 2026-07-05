terraform {
  required_version = ">= 1.5.0"

  required_providers {
    grafana = {
      source  = "grafana/grafana"
      version = "~> 3.0"
    }
  }

  # Remote backend — configure before production use (spec §3.3, §6.2)
  backend "s3" {
    bucket         = "graft-ai-tfstate"
    key            = "terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "graft-ai-tf-locks"
  }
}
