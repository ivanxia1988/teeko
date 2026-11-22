ALTER TABLE teeko_model_credentials DROP CONSTRAINT teeko_model_credentials_provider_check;
ALTER TABLE teeko_model_credentials ADD CONSTRAINT teeko_model_credentials_provider_check CHECK (provider IN ('qwen','openai','grok'));
