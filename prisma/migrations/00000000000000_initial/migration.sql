-- Sales Nebula CRM schema
-- 286 tables

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS "User" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" TEXT UNIQUE NOT NULL,
  "password" TEXT NOT NULL,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "avatar" TEXT,
  "active" BOOLEAN DEFAULT TRUE,
  "roleId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_user_roleId" ON "User" ("roleId");

CREATE TABLE IF NOT EXISTS "Role" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT UNIQUE NOT NULL,
  "description" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "Permission" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "roleId" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "level" TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_permission_roleId_module" ON "Permission" ("roleId", "module");

CREATE TABLE IF NOT EXISTS "Contact" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "email" TEXT,
  "phone" TEXT,
  "mobile" TEXT,
  "mobilePhone" TEXT,
  "title" TEXT,
  "department" TEXT,
  "status" TEXT DEFAULT 'Active',
  "source" TEXT,
  "leadSource" TEXT,
  "address" TEXT,
  "city" TEXT,
  "state" TEXT,
  "country" TEXT,
  "description" TEXT,
  "accountId" TEXT,
  "ownerId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_contact_accountId" ON "Contact" ("accountId");
CREATE INDEX IF NOT EXISTS "idx_contact_ownerId" ON "Contact" ("ownerId");

CREATE TABLE IF NOT EXISTS "Lead" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "email" TEXT,
  "phone" TEXT,
  "company" TEXT NOT NULL,
  "title" TEXT,
  "source" TEXT DEFAULT 'Website',
  "status" TEXT DEFAULT 'New',
  "rating" TEXT,
  "score" INTEGER DEFAULT 50,
  "value" DOUBLE PRECISION DEFAULT 0,
  "address" TEXT,
  "city" TEXT,
  "state" TEXT,
  "country" TEXT,
  "description" TEXT,
  "assignedId" TEXT,
  "ownerId" TEXT,
  "convertedAt" TIMESTAMPTZ,
  "contactId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_lead_ownerId" ON "Lead" ("ownerId");
CREATE INDEX IF NOT EXISTS "idx_lead_assignedId" ON "Lead" ("assignedId");

CREATE TABLE IF NOT EXISTS "Deal" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "stage" TEXT DEFAULT 'Qualification',
  "value" DOUBLE PRECISION DEFAULT 0,
  "probability" INTEGER DEFAULT 10,
  "closeDate" TIMESTAMPTZ,
  "description" TEXT,
  "source" TEXT,
  "competitors" JSONB,
  "lossReason" TEXT,
  "ownerId" TEXT,
  "accountId" TEXT,
  "contactId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "type" TEXT
);
CREATE INDEX IF NOT EXISTS "idx_deal_accountId" ON "Deal" ("accountId");
CREATE INDEX IF NOT EXISTS "idx_deal_contactId" ON "Deal" ("contactId");
CREATE INDEX IF NOT EXISTS "idx_deal_ownerId" ON "Deal" ("ownerId");

CREATE TABLE IF NOT EXISTS "DealStageHistory" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealId" TEXT NOT NULL,
  "fromStage" TEXT,
  "toStage" TEXT NOT NULL,
  "changedById" TEXT,
  "duration" INTEGER,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "Account" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "industry" TEXT,
  "type" TEXT DEFAULT 'Prospect',
  "revenue" DOUBLE PRECISION DEFAULT 0,
  "annualRevenue" DOUBLE PRECISION,
  "employees" INTEGER DEFAULT 0,
  "phone" TEXT,
  "website" TEXT,
  "address" TEXT,
  "city" TEXT,
  "state" TEXT,
  "country" TEXT,
  "billing" TEXT,
  "billingCity" TEXT,
  "billingState" TEXT,
  "billingCountry" TEXT,
  "billingStreet" TEXT,
  "billingZip" TEXT,
  "rating" INTEGER DEFAULT 0,
  "description" TEXT,
  "parentId" TEXT,
  "ownerId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_account_ownerId" ON "Account" ("ownerId");

CREATE TABLE IF NOT EXISTS "Activity" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "type" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "date" TIMESTAMPTZ NOT NULL,
  "priority" TEXT DEFAULT 'Medium',
  "status" TEXT DEFAULT 'Scheduled',
  "contactId" TEXT,
  "dealId" TEXT,
  "accountId" TEXT,
  "assignedId" TEXT,
  "ownerId" TEXT,
  "completedAt" TIMESTAMPTZ,
  "dueDate" TIMESTAMPTZ,
  "duration" INTEGER,
  "description" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "description" TEXT,
  "dueDate" TIMESTAMPTZ,
  "duration" INTEGER,
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_activity_contactId" ON "Activity" ("contactId");
CREATE INDEX IF NOT EXISTS "idx_activity_dealId" ON "Activity" ("dealId");
CREATE INDEX IF NOT EXISTS "idx_activity_accountId" ON "Activity" ("accountId");
CREATE INDEX IF NOT EXISTS "idx_activity_assignedId" ON "Activity" ("assignedId");

CREATE TABLE IF NOT EXISTS "Email" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "subject" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "status" TEXT DEFAULT 'draft',
  "opened" BOOLEAN DEFAULT FALSE,
  "openedAt" TIMESTAMPTZ,
  "sentAt" TIMESTAMPTZ,
  "contactId" TEXT,
  "dealId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "from" TEXT,
  "to" TEXT,
  "toEmail" TEXT,
  "clicked" BOOLEAN DEFAULT FALSE,
  "templateId" TEXT,
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_email_contactId" ON "Email" ("contactId");
CREATE INDEX IF NOT EXISTS "idx_email_dealId" ON "Email" ("dealId");

CREATE TABLE IF NOT EXISTS "EmailTemplate" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "category" TEXT
);

CREATE TABLE IF NOT EXISTS "Case" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "caseNumber" TEXT UNIQUE NOT NULL,
  "subject" TEXT NOT NULL,
  "description" TEXT,
  "type" TEXT DEFAULT 'Problem',
  "status" TEXT DEFAULT 'New',
  "priority" TEXT DEFAULT 'Medium',
  "resolution" TEXT,
  "contactId" TEXT,
  "accountId" TEXT,
  "dealId" TEXT,
  "assignedId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "closedAt" TIMESTAMPTZ,
  "origin" TEXT,
  "emailThreadId" TEXT,
  "lastEmailMessageId" TEXT,
  "emailCount" INTEGER DEFAULT 0,
  "lastEmailAt" TIMESTAMPTZ,
  "contactEmail" TEXT,
  "contactPhone" TEXT,
  "webFormName" TEXT,
  "product" TEXT,
  "customFields" JSONB,
  "ownerId" TEXT,
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_case_accountId" ON "Case" ("accountId");
CREATE INDEX IF NOT EXISTS "idx_case_contactId" ON "Case" ("contactId");
CREATE INDEX IF NOT EXISTS "idx_case_assignedId" ON "Case" ("assignedId");

CREATE TABLE IF NOT EXISTS "CaseComment" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "caseId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "text" TEXT NOT NULL,
  "isInternal" BOOLEAN NOT NULL,
  "isPublic" BOOLEAN DEFAULT FALSE,
  "authorEmail" TEXT DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS "idx_case_comment_caseId" ON "CaseComment" ("caseId");
CREATE INDEX IF NOT EXISTS "idx_case_comment_authorId" ON "CaseComment" ("authorId");

CREATE TABLE IF NOT EXISTS "Document" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "fileName" TEXT,
  "fileSize" INTEGER DEFAULT 0,
  "mimeType" TEXT,
  "filePath" TEXT,
  "category" TEXT DEFAULT 'General',
  "description" TEXT,
  "version" INTEGER DEFAULT 1,
  "linkedModule" TEXT,
  "linkedId" TEXT,
  "contactId" TEXT,
  "dealId" TEXT,
  "accountId" TEXT,
  "caseId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_document_contactId" ON "Document" ("contactId");
CREATE INDEX IF NOT EXISTS "idx_document_dealId" ON "Document" ("dealId");
CREATE INDEX IF NOT EXISTS "idx_document_accountId" ON "Document" ("accountId");
CREATE INDEX IF NOT EXISTS "idx_document_caseId" ON "Document" ("caseId");

CREATE TABLE IF NOT EXISTS "Campaign" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "type" TEXT DEFAULT 'Email',
  "status" TEXT DEFAULT 'Planned',
  "budget" DOUBLE PRECISION DEFAULT 0,
  "actualCost" DOUBLE PRECISION DEFAULT 0,
  "startDate" TIMESTAMPTZ,
  "endDate" TIMESTAMPTZ,
  "description" TEXT,
  "expectedRevenue" DOUBLE PRECISION,
  "ownerId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_campaign_ownerId" ON "Campaign" ("ownerId");

CREATE TABLE IF NOT EXISTS "CampaignRecipient" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "campaignId" TEXT NOT NULL,
  "contactId" TEXT,
  "leadId" TEXT,
  "status" TEXT DEFAULT 'pending',
  "sentAt" TIMESTAMPTZ,
  "openedAt" TIMESTAMPTZ,
  "clickedAt" TIMESTAMPTZ,
  "email" TEXT
);
CREATE INDEX IF NOT EXISTS "idx_campaign_recipient_campaignId" ON "CampaignRecipient" ("campaignId");
CREATE INDEX IF NOT EXISTS "idx_campaign_recipient_contactId" ON "CampaignRecipient" ("contactId");
CREATE INDEX IF NOT EXISTS "idx_campaign_recipient_leadId" ON "CampaignRecipient" ("leadId");

CREATE TABLE IF NOT EXISTS "TargetList" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "campaignId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "description" TEXT,
  "memberCount" INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "Product" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "sku" TEXT UNIQUE NOT NULL,
  "category" TEXT DEFAULT 'License',
  "price" DOUBLE PRECISION DEFAULT 0,
  "cost" DOUBLE PRECISION DEFAULT 0,
  "description" TEXT,
  "unit" TEXT DEFAULT 'each',
  "active" BOOLEAN DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "Quote" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "number" TEXT UNIQUE NOT NULL,
  "status" TEXT DEFAULT 'Draft',
  "total" DOUBLE PRECISION DEFAULT 0,
  "discount" DOUBLE PRECISION DEFAULT 0,
  "tax" DOUBLE PRECISION DEFAULT 0,
  "notes" TEXT,
  "validUntil" TIMESTAMPTZ,
  "dealId" TEXT,
  "accountId" TEXT,
  "contactId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "subtotal" DOUBLE PRECISION DEFAULT 0,
  "terms" TEXT,
  "deletedAt" TIMESTAMPTZ,
  "totalAmount" DOUBLE PRECISION DEFAULT 0,
  "quoteNumber" TEXT,
  "expirationDate" TIMESTAMPTZ,
  "name" TEXT
);
CREATE INDEX IF NOT EXISTS "idx_quote_dealId" ON "Quote" ("dealId");
CREATE INDEX IF NOT EXISTS "idx_quote_accountId" ON "Quote" ("accountId");
CREATE INDEX IF NOT EXISTS "idx_quote_contactId" ON "Quote" ("contactId");

CREATE TABLE IF NOT EXISTS "QuoteItem" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "quoteId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "quantity" INTEGER DEFAULT 1,
  "description" TEXT,
  "unitPrice" DOUBLE PRECISION NOT NULL,
  "total" DOUBLE PRECISION DEFAULT 0,
  "discount" DOUBLE PRECISION DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "idx_quote_item_quoteId" ON "QuoteItem" ("quoteId");
CREATE INDEX IF NOT EXISTS "idx_quote_item_productId" ON "QuoteItem" ("productId");

CREATE TABLE IF NOT EXISTS "Invoice" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "number" TEXT UNIQUE NOT NULL,
  "status" TEXT DEFAULT 'Draft',
  "tax" DOUBLE PRECISION DEFAULT 0,
  "notes" TEXT,
  "dueDate" TIMESTAMPTZ,
  "paidDate" TIMESTAMPTZ,
  "payMethod" TEXT,
  "quoteId" TEXT,
  "accountId" TEXT,
  "contactId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "subtotal" DOUBLE PRECISION DEFAULT 0,
  "total" DOUBLE PRECISION DEFAULT 0,
  "terms" TEXT,
  "date" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ,
  "totalAmount" DOUBLE PRECISION DEFAULT 0,
  "invoiceNumber" TEXT
);
CREATE INDEX IF NOT EXISTS "idx_invoice_quoteId" ON "Invoice" ("quoteId");
CREATE INDEX IF NOT EXISTS "idx_invoice_accountId" ON "Invoice" ("accountId");
CREATE INDEX IF NOT EXISTS "idx_invoice_contactId" ON "Invoice" ("contactId");

CREATE TABLE IF NOT EXISTS "InvoiceItem" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "invoiceId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "quantity" INTEGER DEFAULT 1,
  "description" TEXT,
  "unitPrice" DOUBLE PRECISION NOT NULL,
  "total" DOUBLE PRECISION DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "idx_invoice_item_invoiceId" ON "InvoiceItem" ("invoiceId");
CREATE INDEX IF NOT EXISTS "idx_invoice_item_productId" ON "InvoiceItem" ("productId");

CREATE TABLE IF NOT EXISTS "Workflow" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "module" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "conditions" JSONB
);

CREATE TABLE IF NOT EXISTS "WorkflowLog" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflowId" TEXT NOT NULL,
  "workflowName" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "success" BOOLEAN DEFAULT TRUE,
  "error" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_workflow_log_workflowId" ON "WorkflowLog" ("workflowId");

CREATE TABLE IF NOT EXISTS "CustomField" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "module" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "fieldKey" TEXT UNIQUE NOT NULL,
  "type" TEXT DEFAULT 'text',
  "options" TEXT,
  "required" BOOLEAN DEFAULT FALSE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "CustomFieldValue" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "customFieldId" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "recordId" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_custom_field_value_customFieldId" ON "CustomFieldValue" ("customFieldId");
CREATE INDEX IF NOT EXISTS "idx_custom_field_value_recordId" ON "CustomFieldValue" ("recordId");

CREATE TABLE IF NOT EXISTS "AuditLog" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "action" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "recordId" TEXT,
  "details" TEXT,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_audit_log_userId" ON "AuditLog" ("userId");

CREATE TABLE IF NOT EXISTS "Notification" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "read" BOOLEAN DEFAULT FALSE,
  "userId" TEXT NOT NULL,
  "recordModule" TEXT,
  "recordId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "AdminConfig" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "key" TEXT UNIQUE NOT NULL,
  "value" TEXT NOT NULL,
  "description" TEXT,
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "Forecast" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "periodStart" TIMESTAMPTZ NOT NULL,
  "periodEnd" TIMESTAMPTZ NOT NULL,
  "quotaAmount" DOUBLE PRECISION DEFAULT 0,
  "userId" TEXT NOT NULL,
  "ownerId" TEXT,
  "territoryId" TEXT,
  "status" TEXT DEFAULT 'Open',
  "bestCase" DOUBLE PRECISION DEFAULT 0,
  "commit" DOUBLE PRECISION DEFAULT 0,
  "pipeline" DOUBLE PRECISION DEFAULT 0,
  "closed" DOUBLE PRECISION DEFAULT 0,
  "notes" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_forecast_ownerId" ON "Forecast" ("ownerId");

CREATE TABLE IF NOT EXISTS "ForecastItem" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "forecastId" TEXT NOT NULL,
  "dealId" TEXT NOT NULL,
  "category" TEXT DEFAULT 'Pipeline',
  "amount" DOUBLE PRECISION DEFAULT 0,
  "probability" INTEGER DEFAULT 0,
  "closeDate" TIMESTAMPTZ,
  "notes" TEXT,
  "overrideAmount" DOUBLE PRECISION,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_forecast_item_forecastId" ON "ForecastItem" ("forecastId");
CREATE INDEX IF NOT EXISTS "idx_forecast_item_dealId" ON "ForecastItem" ("dealId");

CREATE TABLE IF NOT EXISTS "ProductBundle" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "active" BOOLEAN DEFAULT TRUE,
  "minItems" INTEGER DEFAULT 1,
  "maxItems" INTEGER,
  "discount" DOUBLE PRECISION DEFAULT 0,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "ProductBundleItem" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "bundleId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "quantity" INTEGER DEFAULT 1,
  "required" BOOLEAN DEFAULT TRUE,
  "sortOrder" INTEGER DEFAULT 0,
  "parentProductId" TEXT
);
CREATE INDEX IF NOT EXISTS "idx_product_bundle_item_bundleId" ON "ProductBundleItem" ("bundleId");

CREATE TABLE IF NOT EXISTS "Pricebook" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "active" BOOLEAN DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "isDefault" BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS "PricebookEntry" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "pricebookId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "unitPrice" DOUBLE PRECISION NOT NULL,
  "active" BOOLEAN DEFAULT TRUE,
  "minQuantity" INTEGER,
  "maxQuantity" INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_pricebook_entry_pricebookId_productId" ON "PricebookEntry" ("pricebookId", "productId");

CREATE TABLE IF NOT EXISTS "DiscountSchedule" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "type" TEXT DEFAULT 'volume',
  "description" TEXT,
  "active" BOOLEAN DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "DiscountTier" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "scheduleId" TEXT NOT NULL,
  "discountPercent" DOUBLE PRECISION NOT NULL,
  "minQuantity" INTEGER NOT NULL,
  "maxQuantity" INTEGER
);
CREATE INDEX IF NOT EXISTS "idx_discount_tier_scheduleId" ON "DiscountTier" ("scheduleId");

CREATE TABLE IF NOT EXISTS "ProductDiscountSchedule" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "productId" TEXT NOT NULL,
  "scheduleId" TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_product_discount_schedule_productId_scheduleId" ON "ProductDiscountSchedule" ("productId", "scheduleId");

CREATE TABLE IF NOT EXISTS "ApprovalProcess" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "module" TEXT NOT NULL,
  "active" BOOLEAN DEFAULT TRUE,
  "entryConditions" JSONB,
  "finalApprovalAction" TEXT DEFAULT 'none',
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "finalRejectionAction" TEXT
);

CREATE TABLE IF NOT EXISTS "ApprovalProcessStep" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "processId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "approverType" TEXT DEFAULT 'user',
  "approverId" TEXT,
  "stepOrder" INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "idx_approval_process_step_processId" ON "ApprovalProcessStep" ("processId");

CREATE TABLE IF NOT EXISTS "ApprovalRequest" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "processId" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "status" TEXT DEFAULT 'Pending',
  "currentStep" INTEGER DEFAULT 1,
  "submittedById" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "recordModule" TEXT
);
CREATE INDEX IF NOT EXISTS "idx_approval_request_processId" ON "ApprovalRequest" ("processId");
CREATE INDEX IF NOT EXISTS "idx_approval_request_recordId" ON "ApprovalRequest" ("recordId");
CREATE INDEX IF NOT EXISTS "idx_approval_request_submittedById" ON "ApprovalRequest" ("submittedById");

CREATE TABLE IF NOT EXISTS "ApprovalStep" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "requestId" TEXT NOT NULL,
  "approverId" TEXT NOT NULL,
  "status" TEXT DEFAULT 'Pending',
  "comments" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "decidedAt" TIMESTAMPTZ,
  "stepOrder" INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "idx_approval_step_requestId" ON "ApprovalStep" ("requestId");
CREATE INDEX IF NOT EXISTS "idx_approval_step_approverId" ON "ApprovalStep" ("approverId");

CREATE TABLE IF NOT EXISTS "Territory" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "parentId" TEXT,
  "region" TEXT,
  "type" TEXT DEFAULT 'Sales',
  "active" BOOLEAN DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_territory_parentId" ON "Territory" ("parentId");

CREATE TABLE IF NOT EXISTS "TerritoryMember" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "territoryId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" TEXT DEFAULT 'Member'
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_territory_member_territoryId_userId" ON "TerritoryMember" ("territoryId", "userId");

CREATE TABLE IF NOT EXISTS "TerritoryAccount" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "territoryId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "assignedBy" TEXT DEFAULT 'manual'
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_territory_account_territoryId_accountId" ON "TerritoryAccount" ("territoryId", "accountId");

CREATE TABLE IF NOT EXISTS "TerritoryRule" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "territoryId" TEXT NOT NULL,
  "field" TEXT NOT NULL,
  "operator" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "active" BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS "KnowledgeArticle" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "title" TEXT NOT NULL,
  "slug" TEXT UNIQUE NOT NULL,
  "body" TEXT NOT NULL,
  "summary" TEXT,
  "category" TEXT DEFAULT 'General',
  "status" TEXT DEFAULT 'Draft',
  "visibility" TEXT DEFAULT 'Internal',
  "authorId" TEXT NOT NULL,
  "version" INTEGER DEFAULT 1,
  "viewCount" INTEGER DEFAULT 0,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "categoryId" TEXT,
  "helpfulYes" INTEGER DEFAULT 0,
  "helpfulNo" INTEGER DEFAULT 0,
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_knowledge_article_categoryId" ON "KnowledgeArticle" ("categoryId");
CREATE INDEX IF NOT EXISTS "idx_knowledge_article_authorId" ON "KnowledgeArticle" ("authorId");

CREATE TABLE IF NOT EXISTS "KnowledgeAttachment" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "articleId" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "filePath" TEXT NOT NULL,
  "fileSize" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_knowledge_attachment_articleId" ON "KnowledgeAttachment" ("articleId");

CREATE TABLE IF NOT EXISTS "KnowledgeCategory" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT UNIQUE NOT NULL,
  "description" TEXT,
  "parentId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "slug" TEXT,
  "sortOrder" INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "idx_knowledge_category_parentId" ON "KnowledgeCategory" ("parentId");

CREATE TABLE IF NOT EXISTS "ChatterPost" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "body" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "pinned" BOOLEAN DEFAULT FALSE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "parentId" TEXT,
  "parentModule" TEXT,
  "likeCount" INTEGER DEFAULT 0,
  "recordId" TEXT,
  "recordModule" TEXT
);
CREATE INDEX IF NOT EXISTS "idx_chatter_post_authorId" ON "ChatterPost" ("authorId");

CREATE TABLE IF NOT EXISTS "ChatterComment" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "body" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_chatter_comment_postId" ON "ChatterComment" ("postId");

CREATE TABLE IF NOT EXISTS "ChatterLike" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "postId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_chatter_like_postId_userId" ON "ChatterLike" ("postId", "userId");

CREATE TABLE IF NOT EXISTS "ChatterMention" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "postId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "Report" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "module" TEXT NOT NULL,
  "reportType" TEXT DEFAULT 'tabular',
  "chartType" TEXT,
  "columns" JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS "ReportFolder" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "parentId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_report_folder_parentId" ON "ReportFolder" ("parentId");

CREATE TABLE IF NOT EXISTS "ReportSchedule" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "reportId" TEXT NOT NULL,
  "cron" TEXT NOT NULL,
  "format" TEXT DEFAULT 'csv',
  "recipients" JSONB DEFAULT '[]',
  "active" BOOLEAN DEFAULT TRUE,
  "lastRun" TIMESTAMPTZ,
  "nextRun" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_report_schedule_reportId" ON "ReportSchedule" ("reportId");

CREATE TABLE IF NOT EXISTS "FormulaField" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "fieldKey" TEXT UNIQUE NOT NULL,
  "module" TEXT NOT NULL,
  "returnType" TEXT DEFAULT 'text',
  "formula" TEXT NOT NULL,
  "precision" INTEGER,
  "active" BOOLEAN DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "Tag" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT UNIQUE NOT NULL,
  "color" TEXT DEFAULT '#6366f1',
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "TagAssignment" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "tagId" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "recordId" TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_tag_assignment_tagId_module_recordId" ON "TagAssignment" ("tagId", "module", "recordId");
CREATE INDEX IF NOT EXISTS "idx_tag_assignment_module_recordId" ON "TagAssignment" ("module", "recordId");

CREATE TABLE IF NOT EXISTS "Note" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "body" TEXT NOT NULL,
  "pinned" BOOLEAN DEFAULT FALSE,
  "module" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_note_module_recordId" ON "Note" ("module", "recordId");

CREATE TABLE IF NOT EXISTS "DealLineItem" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealId" TEXT NOT NULL,
  "productId" TEXT,
  "name" TEXT NOT NULL,
  "quantity" INTEGER DEFAULT 1,
  "price" DOUBLE PRECISION NOT NULL,
  "discount" DOUBLE PRECISION DEFAULT 0,
  "total" DOUBLE PRECISION DEFAULT 0,
  "sortOrder" INTEGER DEFAULT 0,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "LeadScoringRule" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "field" TEXT NOT NULL,
  "operator" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "points" INTEGER NOT NULL,
  "active" BOOLEAN DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "AssignmentRule" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "type" TEXT DEFAULT 'round_robin',
  "conditions" JSONB
);

CREATE TABLE IF NOT EXISTS "EmailSequence" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" TEXT DEFAULT 'Draft',
  "steps" JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS "EmailSequenceEnrollment" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "sequenceId" TEXT NOT NULL,
  "contactId" TEXT,
  "leadId" TEXT,
  "currentStep" INTEGER DEFAULT 0,
  "status" TEXT DEFAULT 'Active',
  "nextSendAt" TIMESTAMPTZ,
  "completedAt" TIMESTAMPTZ,
  "enrolledAt" TIMESTAMPTZ DEFAULT NOW(),
  "enrolledById" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_email_sequence_enrollment_contactId" ON "EmailSequenceEnrollment" ("contactId");
CREATE INDEX IF NOT EXISTS "idx_email_sequence_enrollment_leadId" ON "EmailSequenceEnrollment" ("leadId");

CREATE TABLE IF NOT EXISTS "SavedView" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "filters" JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS "SlaPolicy" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "priority" TEXT NOT NULL,
  "firstResponseMinutes" INTEGER DEFAULT 480,
  "resolutionMinutes" INTEGER DEFAULT 2880,
  "escalateAfterMinutes" INTEGER,
  "active" BOOLEAN DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "Webhook" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "secret" TEXT,
  "events" JSONB NOT NULL,
  "active" BOOLEAN DEFAULT TRUE,
  "headers" JSONB,
  "retries" INTEGER DEFAULT 3,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "WebhookLog" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "webhookId" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "statusCode" INTEGER,
  "response" TEXT,
  "success" BOOLEAN DEFAULT FALSE,
  "attempts" INTEGER DEFAULT 1,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "RecycleBinItem" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "module" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "recordData" JSONB NOT NULL,
  "deletedById" TEXT NOT NULL,
  "deletedAt" TIMESTAMPTZ DEFAULT NOW(),
  "expiresAt" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS "ApiKey" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "key" TEXT UNIQUE NOT NULL,
  "prefix" TEXT NOT NULL,
  "permissions" JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS "SharingRule" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "sharedFrom" JSONB
);

CREATE TABLE IF NOT EXISTS "RecordShare" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "module" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "sharedWithId" TEXT NOT NULL,
  "sharedById" TEXT NOT NULL,
  "accessLevel" TEXT DEFAULT 'read',
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_record_share_module_recordId_sharedWithId" ON "RecordShare" ("module", "recordId", "sharedWithId");
CREATE INDEX IF NOT EXISTS "idx_record_share_module_recordId" ON "RecordShare" ("module", "recordId");
CREATE INDEX IF NOT EXISTS "idx_record_share_sharedWithId" ON "RecordShare" ("sharedWithId");

CREATE TABLE IF NOT EXISTS "Currency" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" TEXT UNIQUE NOT NULL,
  "name" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "exchangeRate" DOUBLE PRECISION DEFAULT 1.0,
  "isDefault" BOOLEAN DEFAULT FALSE,
  "active" BOOLEAN DEFAULT TRUE,
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "Contract" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "contractNumber" TEXT UNIQUE NOT NULL,
  "accountId" TEXT NOT NULL,
  "contactId" TEXT,
  "status" TEXT DEFAULT 'Draft',
  "startDate" TIMESTAMPTZ NOT NULL,
  "endDate" TIMESTAMPTZ NOT NULL,
  "contractTerm" INTEGER DEFAULT 12,
  "billingFrequency" TEXT DEFAULT 'Monthly',
  "totalValue" DOUBLE PRECISION DEFAULT 0,
  "renewalDate" TIMESTAMPTZ,
  "autoRenew" BOOLEAN DEFAULT FALSE,
  "specialTerms" TEXT,
  "description" TEXT,
  "ownerId" TEXT,
  "dealId" TEXT,
  "quoteId" TEXT,
  "signedDate" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ,
  "value" DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS "idx_contract_accountId" ON "Contract" ("accountId");
CREATE INDEX IF NOT EXISTS "idx_contract_contactId" ON "Contract" ("contactId");
CREATE INDEX IF NOT EXISTS "idx_contract_ownerId" ON "Contract" ("ownerId");

CREATE TABLE IF NOT EXISTS "Order" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "orderNumber" TEXT UNIQUE NOT NULL,
  "accountId" TEXT NOT NULL,
  "contactId" TEXT,
  "contractId" TEXT,
  "quoteId" TEXT,
  "status" TEXT DEFAULT 'Draft',
  "type" TEXT DEFAULT 'New',
  "billingStreet" TEXT,
  "billingCity" TEXT,
  "billingState" TEXT,
  "billingZip" TEXT,
  "billingCountry" TEXT,
  "shippingStreet" TEXT,
  "shippingCity" TEXT,
  "shippingState" TEXT,
  "shippingZip" TEXT,
  "shippingCountry" TEXT,
  "subtotal" DOUBLE PRECISION DEFAULT 0,
  "tax" DOUBLE PRECISION DEFAULT 0,
  "total" DOUBLE PRECISION DEFAULT 0,
  "discount" DOUBLE PRECISION DEFAULT 0,
  "activatedDate" TIMESTAMPTZ,
  "ownerId" TEXT,
  "description" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ,
  "totalAmount" DOUBLE PRECISION DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "idx_order_accountId" ON "Order" ("accountId");
CREATE INDEX IF NOT EXISTS "idx_order_contactId" ON "Order" ("contactId");
CREATE INDEX IF NOT EXISTS "idx_order_contractId" ON "Order" ("contractId");
CREATE INDEX IF NOT EXISTS "idx_order_quoteId" ON "Order" ("quoteId");

CREATE TABLE IF NOT EXISTS "OrderItem" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "orderId" TEXT NOT NULL,
  "productId" TEXT,
  "description" TEXT,
  "quantity" INTEGER DEFAULT 1,
  "unitPrice" DOUBLE PRECISION NOT NULL,
  "total" DOUBLE PRECISION DEFAULT 0,
  "discount" DOUBLE PRECISION DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "idx_order_item_orderId" ON "OrderItem" ("orderId");
CREATE INDEX IF NOT EXISTS "idx_order_item_productId" ON "OrderItem" ("productId");

CREATE TABLE IF NOT EXISTS "Entitlement" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "contractId" TEXT,
  "type" TEXT DEFAULT 'Support',
  "status" TEXT DEFAULT 'Active',
  "startDate" TIMESTAMPTZ NOT NULL,
  "endDate" TIMESTAMPTZ NOT NULL,
  "casesAllowed" INTEGER,
  "casesUsed" INTEGER DEFAULT 0,
  "responseTime" INTEGER,
  "resolutionTime" INTEGER,
  "businessHours" TEXT DEFAULT '24x7',
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ,
  "casesPerEntitlement" INTEGER,
  "remainingCases" INTEGER
);
CREATE INDEX IF NOT EXISTS "idx_entitlement_accountId" ON "Entitlement" ("accountId");
CREATE INDEX IF NOT EXISTS "idx_entitlement_contractId" ON "Entitlement" ("contractId");

CREATE TABLE IF NOT EXISTS "EntitlementMilestone" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "entitlementId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" TEXT DEFAULT 'ResponseTime',
  "triggerMinutes" INTEGER NOT NULL,
  "successAction" JSONB,
  "violationAction" JSONB
);
CREATE INDEX IF NOT EXISTS "idx_entitlement_milestone_entitlementId" ON "EntitlementMilestone" ("entitlementId");

CREATE TABLE IF NOT EXISTS "AccountTeam" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "accountId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" TEXT DEFAULT 'Team Member',
  "access" TEXT DEFAULT 'read',
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_account_team_accountId_userId" ON "AccountTeam" ("accountId", "userId");
CREATE INDEX IF NOT EXISTS "idx_account_team_accountId" ON "AccountTeam" ("accountId");
CREATE INDEX IF NOT EXISTS "idx_account_team_userId" ON "AccountTeam" ("userId");

CREATE TABLE IF NOT EXISTS "DealTeam" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" TEXT DEFAULT 'Team Member',
  "access" TEXT DEFAULT 'read',
  "splitPercent" DOUBLE PRECISION,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_deal_team_dealId_userId" ON "DealTeam" ("dealId", "userId");
CREATE INDEX IF NOT EXISTS "idx_deal_team_dealId" ON "DealTeam" ("dealId");
CREATE INDEX IF NOT EXISTS "idx_deal_team_userId" ON "DealTeam" ("userId");

CREATE TABLE IF NOT EXISTS "CampaignInfluence" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "campaignId" TEXT NOT NULL,
  "dealId" TEXT NOT NULL,
  "contactId" TEXT,
  "model" TEXT DEFAULT 'FirstTouch',
  "influence" DOUBLE PRECISION DEFAULT 0,
  "revenue" DOUBLE PRECISION DEFAULT 0,
  "isPrimary" BOOLEAN DEFAULT FALSE,
  "touchDate" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_campaign_influence_campaignId_dealId_model" ON "CampaignInfluence" ("campaignId", "dealId", "model");
CREATE INDEX IF NOT EXISTS "idx_campaign_influence_campaignId" ON "CampaignInfluence" ("campaignId");
CREATE INDEX IF NOT EXISTS "idx_campaign_influence_dealId" ON "CampaignInfluence" ("dealId");

CREATE TABLE IF NOT EXISTS "DuplicateRule" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "active" BOOLEAN DEFAULT TRUE,
  "action" TEXT DEFAULT 'warn',
  "matchFields" JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS "ValidationRule" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "active" BOOLEAN DEFAULT TRUE,
  "condition" JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS "RecordType" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "active" BOOLEAN DEFAULT TRUE,
  "isDefault" BOOLEAN DEFAULT FALSE,
  "description" TEXT,
  "layoutId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_record_type_module_name" ON "RecordType" ("module", "name");

CREATE TABLE IF NOT EXISTS "PageLayout" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "sections" JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS "OrgWideDefault" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "module" TEXT UNIQUE NOT NULL,
  "internalAccess" TEXT DEFAULT 'ReadWrite',
  "externalAccess" TEXT DEFAULT 'Private',
  "grantAccessUsing" TEXT
);

CREATE TABLE IF NOT EXISTS "FieldPermission" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "roleId" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "field" TEXT NOT NULL,
  "visible" BOOLEAN DEFAULT TRUE,
  "editable" BOOLEAN DEFAULT TRUE
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_field_permission_roleId_module_field" ON "FieldPermission" ("roleId", "module", "field");
CREATE INDEX IF NOT EXISTS "idx_field_permission_roleId" ON "FieldPermission" ("roleId");

CREATE TABLE IF NOT EXISTS "RoleHierarchy" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "roleId" TEXT UNIQUE NOT NULL,
  "parentId" TEXT,
  "level" INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "idx_role_hierarchy_parentId" ON "RoleHierarchy" ("parentId");

CREATE TABLE IF NOT EXISTS "SalesPath" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "module" TEXT NOT NULL,
  "active" BOOLEAN DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "SalesPathStep" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "pathId" TEXT NOT NULL,
  "stageName" TEXT NOT NULL,
  "stepOrder" INTEGER NOT NULL,
  "guidance" TEXT,
  "keyFields" JSONB,
  "successCriteria" TEXT
);
CREATE INDEX IF NOT EXISTS "idx_sales_path_step_pathId" ON "SalesPathStep" ("pathId");

CREATE TABLE IF NOT EXISTS "Macro" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "module" TEXT,
  "actions" JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS "PlatformEvent" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "channel" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "userId" TEXT,
  "module" TEXT,
  "recordId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_platform_event_channel" ON "PlatformEvent" ("channel");
CREATE INDEX IF NOT EXISTS "idx_platform_event_createdAt" ON "PlatformEvent" ("createdAt");

CREATE TABLE IF NOT EXISTS "EventSubscription" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "channel" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "type" TEXT DEFAULT 'webhook',
  "active" BOOLEAN DEFAULT TRUE,
  "secret" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_event_subscription_channel" ON "EventSubscription" ("channel");

CREATE TABLE IF NOT EXISTS "ConnectedApp" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "clientId" TEXT UNIQUE NOT NULL,
  "clientSecret" TEXT NOT NULL,
  "active" BOOLEAN DEFAULT TRUE,
  "createdById" TEXT NOT NULL,
  "description" TEXT,
  "logoUrl" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "OAuthToken" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "appId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "accessToken" TEXT UNIQUE NOT NULL,
  "refreshToken" TEXT UNIQUE,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_o_auth_token_appId" ON "OAuthToken" ("appId");
CREATE INDEX IF NOT EXISTS "idx_o_auth_token_userId" ON "OAuthToken" ("userId");

CREATE TABLE IF NOT EXISTS "DataExport" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "module" TEXT NOT NULL,
  "format" TEXT DEFAULT 'csv',
  "status" TEXT DEFAULT 'pending',
  "filters" JSONB,
  "fileUrl" TEXT,
  "recordCount" INTEGER DEFAULT 0,
  "requestedById" TEXT NOT NULL,
  "scheduleCron" TEXT,
  "completedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "Subscription" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "subscriptionNumber" TEXT UNIQUE NOT NULL,
  "accountId" TEXT NOT NULL,
  "contractId" TEXT,
  "productId" TEXT,
  "status" TEXT DEFAULT 'Active',
  "startDate" TIMESTAMPTZ NOT NULL,
  "endDate" TIMESTAMPTZ NOT NULL,
  "term" INTEGER DEFAULT 12,
  "quantity" INTEGER DEFAULT 1,
  "unitPrice" DOUBLE PRECISION NOT NULL,
  "totalPrice" DOUBLE PRECISION NOT NULL,
  "billingFrequency" TEXT DEFAULT 'Monthly',
  "autoRenew" BOOLEAN DEFAULT FALSE,
  "renewalDate" TIMESTAMPTZ,
  "cancellationDate" TIMESTAMPTZ,
  "cancellationReason" TEXT,
  "ownerId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_subscription_accountId" ON "Subscription" ("accountId");
CREATE INDEX IF NOT EXISTS "idx_subscription_contractId" ON "Subscription" ("contractId");

CREATE TABLE IF NOT EXISTS "RevenueSchedule" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "subscriptionId" TEXT,
  "dealId" TEXT,
  "invoiceId" TEXT,
  "type" TEXT DEFAULT 'Monthly',
  "totalAmount" DOUBLE PRECISION NOT NULL,
  "recognizedAmount" DOUBLE PRECISION DEFAULT 0,
  "startDate" TIMESTAMPTZ NOT NULL,
  "endDate" TIMESTAMPTZ NOT NULL,
  "status" TEXT DEFAULT 'Active',
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_revenue_schedule_subscriptionId" ON "RevenueSchedule" ("subscriptionId");
CREATE INDEX IF NOT EXISTS "idx_revenue_schedule_dealId" ON "RevenueSchedule" ("dealId");

CREATE TABLE IF NOT EXISTS "RevenueScheduleEntry" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "scheduleId" TEXT NOT NULL,
  "period" TIMESTAMPTZ NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "status" TEXT DEFAULT 'Pending',
  "recognizedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_revenue_schedule_entry_scheduleId" ON "RevenueScheduleEntry" ("scheduleId");

CREATE TABLE IF NOT EXISTS "FlowDefinition" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "module" TEXT,
  "type" TEXT DEFAULT 'RecordTriggered',
  "status" TEXT DEFAULT 'Draft',
  "version" INTEGER DEFAULT 1,
  "triggerType" TEXT,
  "triggerConditions" JSONB,
  "canvas" JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS "FlowVersion" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "flowId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "canvas" JSONB NOT NULL,
  "publishedAt" TIMESTAMPTZ,
  "publishedById" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_flow_version_flowId_version" ON "FlowVersion" ("flowId", "version");

CREATE TABLE IF NOT EXISTS "FlowRun" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "flowId" TEXT NOT NULL,
  "status" TEXT DEFAULT 'Running',
  "triggerRecordId" TEXT,
  "triggerModule" TEXT,
  "context" JSONB,
  "log" JSONB,
  "startedAt" TIMESTAMPTZ DEFAULT NOW(),
  "completedAt" TIMESTAMPTZ,
  "error" TEXT
);
CREATE INDEX IF NOT EXISTS "idx_flow_run_flowId" ON "FlowRun" ("flowId");
CREATE INDEX IF NOT EXISTS "idx_flow_run_status" ON "FlowRun" ("status");

CREATE TABLE IF NOT EXISTS "CustomObject" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "apiName" TEXT UNIQUE NOT NULL,
  "label" TEXT NOT NULL,
  "pluralLabel" TEXT NOT NULL,
  "description" TEXT,
  "iconName" TEXT,
  "allowActivities" BOOLEAN DEFAULT TRUE,
  "allowReports" BOOLEAN DEFAULT TRUE,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "CustomObjectField" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "objectId" TEXT NOT NULL,
  "apiName" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "type" TEXT DEFAULT 'Text',
  "required" BOOLEAN DEFAULT FALSE,
  "unique" BOOLEAN DEFAULT FALSE,
  "defaultValue" TEXT,
  "lookupObject" TEXT,
  "formulaExpression" TEXT,
  "length" INTEGER,
  "precision" INTEGER,
  "scale" INTEGER,
  "description" TEXT,
  "sortOrder" INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_custom_object_field_objectId_apiName" ON "CustomObjectField" ("objectId", "apiName");
CREATE INDEX IF NOT EXISTS "idx_custom_object_field_objectId" ON "CustomObjectField" ("objectId");

CREATE TABLE IF NOT EXISTS "CustomObjectRecord" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "objectId" TEXT NOT NULL,
  "data" JSONB NOT NULL,
  "ownerId" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_custom_object_record_objectId" ON "CustomObjectRecord" ("objectId");
CREATE INDEX IF NOT EXISTS "idx_custom_object_record_ownerId" ON "CustomObjectRecord" ("ownerId");

CREATE TABLE IF NOT EXISTS "CallRecording" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealId" TEXT,
  "contactId" TEXT,
  "accountId" TEXT,
  "userId" TEXT NOT NULL,
  "direction" TEXT DEFAULT 'outbound',
  "duration" INTEGER DEFAULT 0,
  "recordingUrl" TEXT,
  "transcription" TEXT,
  "summary" TEXT,
  "sentiment" TEXT,
  "actionItems" JSONB
);

CREATE TABLE IF NOT EXISTS "DialerSession" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "status" TEXT DEFAULT 'idle',
  "phoneNumber" TEXT,
  "contactId" TEXT,
  "callId" TEXT,
  "startedAt" TIMESTAMPTZ DEFAULT NOW(),
  "connectedAt" TIMESTAMPTZ,
  "endedAt" TIMESTAMPTZ,
  "duration" INTEGER,
  "outcome" TEXT,
  "notes" TEXT,
  "recordingId" TEXT
);
CREATE INDEX IF NOT EXISTS "idx_dialer_session_userId" ON "DialerSession" ("userId");

CREATE TABLE IF NOT EXISTS "OmniChannel" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "status" TEXT DEFAULT 'Online',
  "routingType" TEXT DEFAULT 'Queue',
  "priority" INTEGER DEFAULT 5,
  "capacity" INTEGER DEFAULT 10,
  "queueId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "OmniWorkItem" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "channelId" TEXT,
  "type" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "priority" INTEGER DEFAULT 5,
  "status" TEXT DEFAULT 'Queued',
  "assignedTo" TEXT,
  "queuedAt" TIMESTAMPTZ DEFAULT NOW(),
  "assignedAt" TIMESTAMPTZ,
  "completedAt" TIMESTAMPTZ,
  "waitTime" INTEGER,
  "handleTime" INTEGER
);
CREATE INDEX IF NOT EXISTS "idx_omni_work_item_status" ON "OmniWorkItem" ("status");
CREATE INDEX IF NOT EXISTS "idx_omni_work_item_assignedTo" ON "OmniWorkItem" ("assignedTo");

CREATE TABLE IF NOT EXISTS "ChatSession" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "visitorId" TEXT NOT NULL,
  "visitorName" TEXT,
  "visitorEmail" TEXT,
  "agentId" TEXT,
  "caseId" TEXT,
  "status" TEXT DEFAULT 'Waiting',
  "channel" TEXT DEFAULT 'web',
  "department" TEXT,
  "startedAt" TIMESTAMPTZ DEFAULT NOW(),
  "endedAt" TIMESTAMPTZ,
  "rating" INTEGER,
  "transcript" JSONB
);

CREATE TABLE IF NOT EXISTS "WorkOrder" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "workOrderNumber" TEXT UNIQUE NOT NULL,
  "accountId" TEXT,
  "contactId" TEXT,
  "caseId" TEXT,
  "subject" TEXT NOT NULL,
  "description" TEXT,
  "status" TEXT DEFAULT 'New',
  "priority" TEXT DEFAULT 'Medium',
  "type" TEXT,
  "startDate" TIMESTAMPTZ,
  "endDate" TIMESTAMPTZ,
  "address" TEXT,
  "latitude" DOUBLE PRECISION,
  "longitude" DOUBLE PRECISION,
  "ownerId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_work_order_accountId" ON "WorkOrder" ("accountId");
CREATE INDEX IF NOT EXISTS "idx_work_order_status" ON "WorkOrder" ("status");

CREATE TABLE IF NOT EXISTS "WorkOrderLineItem" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "workOrderId" TEXT NOT NULL,
  "productId" TEXT,
  "description" TEXT,
  "quantity" INTEGER DEFAULT 1,
  "unitPrice" DOUBLE PRECISION DEFAULT 0,
  "status" TEXT DEFAULT 'New'
);
CREATE INDEX IF NOT EXISTS "idx_work_order_line_item_workOrderId" ON "WorkOrderLineItem" ("workOrderId");

CREATE TABLE IF NOT EXISTS "ServiceAppointment" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "appointmentNumber" TEXT UNIQUE NOT NULL,
  "workOrderId" TEXT,
  "contactId" TEXT,
  "technicianId" TEXT,
  "status" TEXT DEFAULT 'Scheduled',
  "scheduledStart" TIMESTAMPTZ NOT NULL,
  "scheduledEnd" TIMESTAMPTZ NOT NULL,
  "actualStart" TIMESTAMPTZ,
  "actualEnd" TIMESTAMPTZ,
  "address" TEXT,
  "latitude" DOUBLE PRECISION,
  "longitude" DOUBLE PRECISION,
  "notes" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_service_appointment_workOrderId" ON "ServiceAppointment" ("workOrderId");
CREATE INDEX IF NOT EXISTS "idx_service_appointment_technicianId" ON "ServiceAppointment" ("technicianId");
CREATE INDEX IF NOT EXISTS "idx_service_appointment_status" ON "ServiceAppointment" ("status");

CREATE TABLE IF NOT EXISTS "SsoConfig" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "active" BOOLEAN DEFAULT TRUE,
  "entityId" TEXT,
  "ssoUrl" TEXT,
  "certificateData" TEXT,
  "clientId" TEXT,
  "clientSecret" TEXT,
  "redirectUri" TEXT,
  "attributeMapping" JSONB
);

CREATE TABLE IF NOT EXISTS "MfaDevice" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "type" TEXT DEFAULT 'totp',
  "secret" TEXT,
  "phone" TEXT,
  "verified" BOOLEAN DEFAULT FALSE,
  "lastUsedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_mfa_device_userId" ON "MfaDevice" ("userId");

CREATE TABLE IF NOT EXISTS "MfaChallenge" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "verified" BOOLEAN DEFAULT FALSE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_mfa_challenge_userId" ON "MfaChallenge" ("userId");

CREATE TABLE IF NOT EXISTS "EncryptionPolicy" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "module" TEXT NOT NULL,
  "field" TEXT NOT NULL,
  "algorithm" TEXT DEFAULT 'AES-256-GCM',
  "active" BOOLEAN DEFAULT TRUE,
  "keyVersion" INTEGER DEFAULT 1,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_encryption_policy_module_field" ON "EncryptionPolicy" ("module", "field");

CREATE TABLE IF NOT EXISTS "EncryptionKey" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "version" INTEGER NOT NULL,
  "keyMaterial" TEXT NOT NULL,
  "status" TEXT DEFAULT 'Active',
  "activatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "archivedAt" TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_encryption_key_version" ON "EncryptionKey" ("version");

CREATE TABLE IF NOT EXISTS "Environment" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT UNIQUE NOT NULL,
  "type" TEXT DEFAULT 'sandbox',
  "status" TEXT DEFAULT 'Active',
  "sourceId" TEXT,
  "dbUrl" TEXT,
  "description" TEXT,
  "createdById" TEXT NOT NULL,
  "refreshedAt" TIMESTAMPTZ,
  "expiresAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "ChangeSet" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "sourceEnv" TEXT NOT NULL,
  "targetEnv" TEXT,
  "status" TEXT DEFAULT 'Open',
  "components" JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS "AnalyticsDataset" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "query" JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS "AnalyticsDashboard" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "datasetId" TEXT,
  "layout" JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS "IntegrationConfig" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "type" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "active" BOOLEAN DEFAULT TRUE,
  "credentials" JSONB,
  "settings" JSONB,
  "webhookUrl" TEXT,
  "lastSyncAt" TIMESTAMPTZ,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "EmailSync" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "syncEnabled" BOOLEAN DEFAULT TRUE,
  "lastSyncAt" TIMESTAMPTZ,
  "syncFilter" JSONB
);

CREATE TABLE IF NOT EXISTS "AppListing" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "slug" TEXT UNIQUE NOT NULL,
  "description" TEXT,
  "longDescription" TEXT,
  "version" TEXT DEFAULT '1.0.0',
  "author" TEXT NOT NULL,
  "authorEmail" TEXT,
  "category" TEXT DEFAULT 'Utility',
  "iconUrl" TEXT,
  "installUrl" TEXT,
  "webhookEndpoint" TEXT,
  "pricing" TEXT DEFAULT 'Free',
  "priceMonthly" DOUBLE PRECISION,
  "rating" DOUBLE PRECISION DEFAULT 0,
  "reviewCount" INTEGER DEFAULT 0,
  "installCount" INTEGER DEFAULT 0,
  "status" TEXT DEFAULT 'Published',
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "AppInstallation" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "appId" TEXT NOT NULL,
  "installedById" TEXT NOT NULL,
  "status" TEXT DEFAULT 'Active',
  "settings" JSONB,
  "installedAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_app_installation_appId_installedById" ON "AppInstallation" ("appId", "installedById");

CREATE TABLE IF NOT EXISTS "CustomScript" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "language" TEXT DEFAULT 'javascript',
  "code" TEXT NOT NULL,
  "trigger" TEXT,
  "module" TEXT,
  "active" BOOLEAN DEFAULT TRUE,
  "timeout" INTEGER DEFAULT 5000,
  "lastRunAt" TIMESTAMPTZ,
  "lastError" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "CustomComponent" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT UNIQUE NOT NULL,
  "label" TEXT NOT NULL,
  "description" TEXT,
  "type" TEXT DEFAULT 'Card',
  "module" TEXT,
  "markup" TEXT NOT NULL,
  "script" TEXT,
  "style" TEXT,
  "properties" JSONB,
  "active" BOOLEAN DEFAULT TRUE,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "UnifiedProfile" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "contactId" TEXT,
  "leadId" TEXT,
  "accountId" TEXT,
  "email" TEXT,
  "phone" TEXT,
  "identifiers" JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS "DataStream" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "module" TEXT,
  "active" BOOLEAN DEFAULT TRUE,
  "mapping" JSONB NOT NULL,
  "lastSyncAt" TIMESTAMPTZ,
  "recordCount" INTEGER DEFAULT 0,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "ProductRule" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "type" TEXT DEFAULT 'Validation',
  "active" BOOLEAN DEFAULT TRUE,
  "scope" TEXT DEFAULT 'Quote',
  "conditions" JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS "PriceRule" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "active" BOOLEAN DEFAULT TRUE,
  "targetObject" TEXT DEFAULT 'QuoteLine',
  "conditions" JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS "GuidedSellingRule" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "active" BOOLEAN DEFAULT TRUE,
  "questions" JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS "ReportType" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "primaryModule" TEXT NOT NULL,
  "joins" JSONB
);

CREATE TABLE IF NOT EXISTS "ScheduledReport" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "reportId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "schedule" TEXT NOT NULL,
  "format" TEXT DEFAULT 'csv',
  "lastRunAt" TIMESTAMPTZ,
  "nextRunAt" TIMESTAMPTZ,
  "active" BOOLEAN DEFAULT TRUE,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "AiAgent" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "type" TEXT DEFAULT 'SDR',
  "description" TEXT,
  "active" BOOLEAN DEFAULT TRUE,
  "config" JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS "AiAgentRun" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "agentId" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "status" TEXT DEFAULT 'Running',
  "input" JSONB,
  "output" JSONB,
  "actions" JSONB
);

CREATE TABLE IF NOT EXISTS "CopilotConversation" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "context" JSONB
);

CREATE TABLE IF NOT EXISTS "MobileDevice" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "deviceId" TEXT UNIQUE NOT NULL,
  "platform" TEXT NOT NULL,
  "pushToken" TEXT,
  "appVersion" TEXT,
  "lastActiveAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_mobile_device_userId" ON "MobileDevice" ("userId");

CREATE TABLE IF NOT EXISTS "PushNotification" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "deviceId" TEXT,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "data" JSONB,
  "status" TEXT DEFAULT 'pending',
  "sentAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_push_notification_userId" ON "PushNotification" ("userId");
CREATE INDEX IF NOT EXISTS "idx_push_notification_status" ON "PushNotification" ("status");

CREATE TABLE IF NOT EXISTS "CampaignMember" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "campaignId" TEXT NOT NULL,
  "contactId" TEXT,
  "leadId" TEXT,
  "status" TEXT DEFAULT 'Sent',
  "firstRespondedDate" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_campaign_member_campaignId_contactId" ON "CampaignMember" ("campaignId", "contactId");
CREATE INDEX IF NOT EXISTS "idx_campaign_member_campaignId" ON "CampaignMember" ("campaignId");
CREATE INDEX IF NOT EXISTS "idx_campaign_member_contactId" ON "CampaignMember" ("contactId");
CREATE INDEX IF NOT EXISTS "idx_campaign_member_leadId" ON "CampaignMember" ("leadId");

CREATE TABLE IF NOT EXISTS "DuplicateRecord" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "ruleId" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "recordIdA" TEXT NOT NULL,
  "recordIdB" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION DEFAULT 0,
  "status" TEXT DEFAULT 'Active',
  "mergedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_duplicate_record_ruleId" ON "DuplicateRecord" ("ruleId");
CREATE INDEX IF NOT EXISTS "idx_duplicate_record_module" ON "DuplicateRecord" ("module");

CREATE TABLE IF NOT EXISTS "EmailTracking" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "emailId" TEXT NOT NULL,
  "contactId" TEXT,
  "type" TEXT NOT NULL,
  "url" TEXT,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "timestamp" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_email_tracking_emailId" ON "EmailTracking" ("emailId");
CREATE INDEX IF NOT EXISTS "idx_email_tracking_contactId" ON "EmailTracking" ("contactId");
CREATE INDEX IF NOT EXISTS "idx_email_tracking_type" ON "EmailTracking" ("type");

CREATE TABLE IF NOT EXISTS "FieldLevelSecurity" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "roleId" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "field" TEXT NOT NULL,
  "readable" BOOLEAN DEFAULT TRUE,
  "editable" BOOLEAN DEFAULT TRUE
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_field_level_security_roleId_module_field" ON "FieldLevelSecurity" ("roleId", "module", "field");
CREATE INDEX IF NOT EXISTS "idx_field_level_security_roleId" ON "FieldLevelSecurity" ("roleId");

CREATE TABLE IF NOT EXISTS "ImportJob" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "module" TEXT NOT NULL,
  "fileName" TEXT,
  "status" TEXT DEFAULT 'Pending',
  "totalRows" INTEGER DEFAULT 0,
  "processedRows" INTEGER DEFAULT 0,
  "successRows" INTEGER DEFAULT 0,
  "failedRows" INTEGER DEFAULT 0,
  "errors" JSONB,
  "mapping" JSONB,
  "createdById" TEXT NOT NULL,
  "startedAt" TIMESTAMPTZ,
  "completedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_import_job_status" ON "ImportJob" ("status");
CREATE INDEX IF NOT EXISTS "idx_import_job_createdById" ON "ImportJob" ("createdById");

CREATE TABLE IF NOT EXISTS "LeadScoreRule" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "field" TEXT NOT NULL,
  "operator" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "score" INTEGER DEFAULT 0,
  "active" BOOLEAN DEFAULT TRUE,
  "sortOrder" INTEGER DEFAULT 0,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "QuoteLineItem" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "quoteId" TEXT NOT NULL,
  "productId" TEXT,
  "description" TEXT,
  "quantity" INTEGER DEFAULT 1,
  "unitPrice" DOUBLE PRECISION DEFAULT 0,
  "discount" DOUBLE PRECISION DEFAULT 0,
  "totalPrice" DOUBLE PRECISION DEFAULT 0,
  "sortOrder" INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "idx_quote_line_item_quoteId" ON "QuoteLineItem" ("quoteId");
CREATE INDEX IF NOT EXISTS "idx_quote_line_item_productId" ON "QuoteLineItem" ("productId");

CREATE TABLE IF NOT EXISTS "WebToLead" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT DEFAULT 'Default',
  "active" BOOLEAN DEFAULT TRUE,
  "returnUrl" TEXT,
  "defaultSource" TEXT DEFAULT 'Web',
  "defaultOwnerId" TEXT,
  "notifyEmail" TEXT,
  "captchaEnabled" BOOLEAN DEFAULT TRUE,
  "fieldMapping" JSONB,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "Attachment" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "parentId" TEXT NOT NULL,
  "parentModule" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "fileSize" INTEGER DEFAULT 0,
  "mimeType" TEXT,
  "url" TEXT,
  "description" TEXT,
  "isPublic" BOOLEAN DEFAULT FALSE,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_attachment_parentId_parentModule" ON "Attachment" ("parentId", "parentModule");
CREATE INDEX IF NOT EXISTS "idx_attachment_createdById" ON "Attachment" ("createdById");

CREATE TABLE IF NOT EXISTS "EmailMessage" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "parentId" TEXT,
  "parentModule" TEXT,
  "fromAddress" TEXT NOT NULL,
  "subject" TEXT,
  "htmlBody" TEXT,
  "textBody" TEXT,
  "status" TEXT DEFAULT 'Sent',
  "isInbound" BOOLEAN DEFAULT FALSE,
  "hasAttachment" BOOLEAN DEFAULT FALSE,
  "messageId" TEXT,
  "threadId" TEXT,
  "sentAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_email_message_parentId_parentModule" ON "EmailMessage" ("parentId", "parentModule");
CREATE INDEX IF NOT EXISTS "idx_email_message_threadId" ON "EmailMessage" ("threadId");

CREATE TABLE IF NOT EXISTS "PersonAccount" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "email" TEXT UNIQUE,
  "phone" TEXT,
  "mobilePhone" TEXT,
  "mailingAddress" TEXT,
  "billingAddress" TEXT,
  "birthdate" TIMESTAMPTZ,
  "gender" TEXT,
  "source" TEXT,
  "ownerId" TEXT,
  "accountId" TEXT,
  "customFields" JSONB,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_person_account_ownerId" ON "PersonAccount" ("ownerId");
CREATE INDEX IF NOT EXISTS "idx_person_account_email" ON "PersonAccount" ("email");

CREATE TABLE IF NOT EXISTS "DealContactRole" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "role" TEXT DEFAULT 'Decision Maker',
  "isPrimary" BOOLEAN DEFAULT FALSE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_deal_contact_role_dealId_contactId" ON "DealContactRole" ("dealId", "contactId");
CREATE INDEX IF NOT EXISTS "idx_deal_contact_role_dealId" ON "DealContactRole" ("dealId");
CREATE INDEX IF NOT EXISTS "idx_deal_contact_role_contactId" ON "DealContactRole" ("contactId");

CREATE TABLE IF NOT EXISTS "DealSplit" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "splitType" TEXT DEFAULT 'Revenue',
  "percentage" DOUBLE PRECISION DEFAULT 100,
  "amount" DOUBLE PRECISION DEFAULT 0,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_deal_split_dealId_userId_splitType" ON "DealSplit" ("dealId", "userId", "splitType");
CREATE INDEX IF NOT EXISTS "idx_deal_split_dealId" ON "DealSplit" ("dealId");
CREATE INDEX IF NOT EXISTS "idx_deal_split_userId" ON "DealSplit" ("userId");

CREATE TABLE IF NOT EXISTS "Asset" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "accountId" TEXT,
  "contactId" TEXT,
  "productId" TEXT,
  "serialNumber" TEXT,
  "status" TEXT DEFAULT 'Installed',
  "purchaseDate" TIMESTAMPTZ,
  "installDate" TIMESTAMPTZ,
  "usageEndDate" TIMESTAMPTZ,
  "quantity" DOUBLE PRECISION DEFAULT 1,
  "price" DOUBLE PRECISION,
  "description" TEXT,
  "parentAssetId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_asset_accountId" ON "Asset" ("accountId");
CREATE INDEX IF NOT EXISTS "idx_asset_contactId" ON "Asset" ("contactId");
CREATE INDEX IF NOT EXISTS "idx_asset_productId" ON "Asset" ("productId");
CREATE INDEX IF NOT EXISTS "idx_asset_serialNumber" ON "Asset" ("serialNumber");

CREATE TABLE IF NOT EXISTS "PartnerAccount" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "accountId" TEXT NOT NULL,
  "partnerLevel" TEXT DEFAULT 'Silver',
  "status" TEXT DEFAULT 'Active',
  "territory" TEXT,
  "portalEnabled" BOOLEAN DEFAULT FALSE,
  "portalUserId" TEXT,
  "dealRegistrations" INTEGER DEFAULT 0,
  "revenueGenerated" DOUBLE PRECISION DEFAULT 0,
  "contractId" TEXT,
  "startDate" TIMESTAMPTZ,
  "endDate" TIMESTAMPTZ,
  "ownerId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_partner_account_accountId" ON "PartnerAccount" ("accountId");
CREATE INDEX IF NOT EXISTS "idx_partner_account_status" ON "PartnerAccount" ("status");

CREATE TABLE IF NOT EXISTS "Survey" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" TEXT DEFAULT 'Draft',
  "type" TEXT DEFAULT 'CSAT',
  "questions" JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS "SurveyResponse" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "surveyId" TEXT NOT NULL,
  "contactId" TEXT,
  "caseId" TEXT,
  "answers" JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS "ConsentRecord" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "contactId" TEXT,
  "leadId" TEXT,
  "personAccountId" TEXT,
  "email" TEXT,
  "consentType" TEXT NOT NULL,
  "status" TEXT DEFAULT 'OptIn',
  "source" TEXT,
  "consentDate" TIMESTAMPTZ DEFAULT NOW(),
  "expiryDate" TIMESTAMPTZ,
  "ipAddress" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_consent_record_contactId" ON "ConsentRecord" ("contactId");
CREATE INDEX IF NOT EXISTS "idx_consent_record_email" ON "ConsentRecord" ("email");
CREATE INDEX IF NOT EXISTS "idx_consent_record_consentType" ON "ConsentRecord" ("consentType");

CREATE TABLE IF NOT EXISTS "BookingSlot" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "startTime" TIMESTAMPTZ NOT NULL,
  "endTime" TIMESTAMPTZ NOT NULL,
  "status" TEXT DEFAULT 'Available',
  "bookingType" TEXT DEFAULT 'Meeting',
  "contactId" TEXT,
  "accountId" TEXT,
  "dealId" TEXT,
  "location" TEXT,
  "meetingUrl" TEXT,
  "notes" TEXT,
  "reminderSent" BOOLEAN DEFAULT FALSE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_booking_slot_userId" ON "BookingSlot" ("userId");
CREATE INDEX IF NOT EXISTS "idx_booking_slot_startTime_endTime" ON "BookingSlot" ("startTime", "endTime");
CREATE INDEX IF NOT EXISTS "idx_booking_slot_status" ON "BookingSlot" ("status");

CREATE TABLE IF NOT EXISTS "TerritoryModel" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "status" TEXT DEFAULT 'Planning',
  "description" TEXT,
  "createdById" TEXT NOT NULL,
  "activatedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "TerritoryAssignment" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "territoryId" TEXT NOT NULL,
  "recordType" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_territory_assignment_territoryId_recordType_recordId" ON "TerritoryAssignment" ("territoryId", "recordType", "recordId");
CREATE INDEX IF NOT EXISTS "idx_territory_assignment_territoryId" ON "TerritoryAssignment" ("territoryId");
CREATE INDEX IF NOT EXISTS "idx_territory_assignment_recordId" ON "TerritoryAssignment" ("recordId");

CREATE TABLE IF NOT EXISTS "QuoteTemplate" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "isDefault" BOOLEAN DEFAULT FALSE,
  "headerHtml" TEXT,
  "bodyHtml" TEXT,
  "footerHtml" TEXT,
  "logoUrl" TEXT,
  "termsAndConditions" TEXT,
  "pageSize" TEXT DEFAULT 'A4',
  "active" BOOLEAN DEFAULT TRUE,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "DealHistory" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealId" TEXT NOT NULL,
  "field" TEXT NOT NULL,
  "oldValue" TEXT,
  "newValue" TEXT,
  "changedById" TEXT NOT NULL,
  "changedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_deal_history_dealId" ON "DealHistory" ("dealId");
CREATE INDEX IF NOT EXISTS "idx_deal_history_changedAt" ON "DealHistory" ("changedAt");

CREATE TABLE IF NOT EXISTS "LoginHistory" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "loginTime" TIMESTAMPTZ DEFAULT NOW(),
  "sourceIp" TEXT,
  "browser" TEXT,
  "platform" TEXT,
  "status" TEXT DEFAULT 'Success',
  "loginType" TEXT DEFAULT 'password',
  "sessionId" TEXT,
  "location" TEXT
);
CREATE INDEX IF NOT EXISTS "idx_login_history_userId" ON "LoginHistory" ("userId");
CREATE INDEX IF NOT EXISTS "idx_login_history_loginTime" ON "LoginHistory" ("loginTime");
CREATE INDEX IF NOT EXISTS "idx_login_history_status" ON "LoginHistory" ("status");

CREATE TABLE IF NOT EXISTS "EventLog" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "eventType" TEXT NOT NULL,
  "userId" TEXT,
  "timestamp" TIMESTAMPTZ DEFAULT NOW(),
  "sourceIp" TEXT,
  "uri" TEXT,
  "method" TEXT,
  "statusCode" INTEGER,
  "responseTime" INTEGER,
  "module" TEXT,
  "recordId" TEXT,
  "action" TEXT,
  "details" JSONB,
  "riskScore" DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS "idx_event_log_eventType" ON "EventLog" ("eventType");
CREATE INDEX IF NOT EXISTS "idx_event_log_userId" ON "EventLog" ("userId");
CREATE INDEX IF NOT EXISTS "idx_event_log_timestamp" ON "EventLog" ("timestamp");

CREATE TABLE IF NOT EXISTS "ActivityRelation" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "activityId" TEXT NOT NULL,
  "relatedId" TEXT NOT NULL,
  "relatedModule" TEXT NOT NULL,
  "isPrimary" BOOLEAN DEFAULT FALSE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_activity_relation_activityId_relatedId_relatedModule" ON "ActivityRelation" ("activityId", "relatedId", "relatedModule");
CREATE INDEX IF NOT EXISTS "idx_activity_relation_activityId" ON "ActivityRelation" ("activityId");
CREATE INDEX IF NOT EXISTS "idx_activity_relation_relatedId" ON "ActivityRelation" ("relatedId");

CREATE TABLE IF NOT EXISTS "PortalConfig" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "type" TEXT DEFAULT 'Customer',
  "domain" TEXT,
  "active" BOOLEAN DEFAULT TRUE,
  "theme" JSONB,
  "selfRegistration" BOOLEAN DEFAULT FALSE,
  "loginPageUrl" TEXT,
  "defaultRoleId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "PortalUser" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "portalId" TEXT NOT NULL,
  "contactId" TEXT,
  "accountId" TEXT,
  "email" TEXT NOT NULL,
  "username" TEXT UNIQUE NOT NULL,
  "password" TEXT NOT NULL,
  "status" TEXT DEFAULT 'Active',
  "roleId" TEXT,
  "lastLoginAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_portal_user_portalId" ON "PortalUser" ("portalId");
CREATE INDEX IF NOT EXISTS "idx_portal_user_contactId" ON "PortalUser" ("contactId");
CREATE INDEX IF NOT EXISTS "idx_portal_user_email" ON "PortalUser" ("email");

CREATE TABLE IF NOT EXISTS "FeedItem" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "parentId" TEXT,
  "parentModule" TEXT,
  "type" TEXT DEFAULT 'TextPost',
  "body" TEXT,
  "linkUrl" TEXT,
  "authorId" TEXT NOT NULL,
  "visibility" TEXT DEFAULT 'AllUsers',
  "likeCount" INTEGER DEFAULT 0,
  "commentCount" INTEGER DEFAULT 0,
  "pinned" BOOLEAN DEFAULT FALSE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_feed_item_parentId_parentModule" ON "FeedItem" ("parentId", "parentModule");
CREATE INDEX IF NOT EXISTS "idx_feed_item_authorId" ON "FeedItem" ("authorId");

CREATE TABLE IF NOT EXISTS "FeedComment" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "feedItemId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_feed_comment_feedItemId" ON "FeedComment" ("feedItemId");

CREATE TABLE IF NOT EXISTS "AgentPresence" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "status" TEXT DEFAULT 'Available',
  "channels" JSONB,
  "capacity" INTEGER DEFAULT 5,
  "lastPing" TIMESTAMPTZ DEFAULT NOW(),
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_agent_presence_userId" ON "AgentPresence" ("userId");
CREATE INDEX IF NOT EXISTS "idx_agent_presence_status" ON "AgentPresence" ("status");

CREATE TABLE IF NOT EXISTS "AiAgentConversation" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "agentId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "messages" JSONB,
  "status" TEXT DEFAULT 'active',
  "metadata" JSONB,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_ai_agent_conversation_agentId" ON "AiAgentConversation" ("agentId");
CREATE INDEX IF NOT EXISTS "idx_ai_agent_conversation_userId" ON "AiAgentConversation" ("userId");

CREATE TABLE IF NOT EXISTS "AiPrediction" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "module" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "prediction" JSONB,
  "confidence" DOUBLE PRECISION,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_ai_prediction_module_recordId" ON "AiPrediction" ("module", "recordId");

CREATE TABLE IF NOT EXISTS "Appointment" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "subject" TEXT NOT NULL,
  "description" TEXT,
  "startTime" TIMESTAMPTZ NOT NULL,
  "endTime" TIMESTAMPTZ NOT NULL,
  "status" TEXT DEFAULT 'Scheduled',
  "location" TEXT,
  "attendees" JSONB,
  "ownerId" TEXT,
  "contactId" TEXT,
  "accountId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_appointment_ownerId" ON "Appointment" ("ownerId");
CREATE INDEX IF NOT EXISTS "idx_appointment_startTime" ON "Appointment" ("startTime");
CREATE INDEX IF NOT EXISTS "idx_appointment_status" ON "Appointment" ("status");

CREATE TABLE IF NOT EXISTS "Approval" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "module" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "status" TEXT DEFAULT 'Pending',
  "requesterId" TEXT NOT NULL,
  "approverId" TEXT,
  "comments" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_approval_status" ON "Approval" ("status");
CREATE INDEX IF NOT EXISTS "idx_approval_approverId" ON "Approval" ("approverId");
CREATE INDEX IF NOT EXISTS "idx_approval_requesterId" ON "Approval" ("requesterId");

CREATE TABLE IF NOT EXISTS "BulkJob" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "type" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "status" TEXT DEFAULT 'Queued',
  "totalRecords" INTEGER DEFAULT 0,
  "processed" INTEGER DEFAULT 0,
  "failed" INTEGER DEFAULT 0,
  "errors" JSONB,
  "data" JSONB,
  "userId" TEXT NOT NULL,
  "startedAt" TIMESTAMPTZ,
  "completedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_bulk_job_status" ON "BulkJob" ("status");
CREATE INDEX IF NOT EXISTS "idx_bulk_job_userId" ON "BulkJob" ("userId");

CREATE TABLE IF NOT EXISTS "CdpEvent" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "contactId" TEXT,
  "type" TEXT NOT NULL,
  "source" TEXT,
  "properties" JSONB,
  "sessionId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_cdp_event_contactId" ON "CdpEvent" ("contactId");
CREATE INDEX IF NOT EXISTS "idx_cdp_event_type" ON "CdpEvent" ("type");
CREATE INDEX IF NOT EXISTS "idx_cdp_event_createdAt" ON "CdpEvent" ("createdAt");

CREATE TABLE IF NOT EXISTS "ConnectedAppLog" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "connectedAppId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "details" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_connected_app_log_connectedAppId" ON "ConnectedAppLog" ("connectedAppId");

CREATE TABLE IF NOT EXISTS "ConsentHistory" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "contactId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "channel" TEXT,
  "action" TEXT NOT NULL,
  "source" TEXT,
  "ipAddress" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_consent_history_contactId" ON "ConsentHistory" ("contactId");

CREATE TABLE IF NOT EXISTS "ContractMilestone" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "contractId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "dueDate" TIMESTAMPTZ,
  "status" TEXT DEFAULT 'Pending',
  "completedAt" TIMESTAMPTZ,
  "amount" DOUBLE PRECISION,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_contract_milestone_contractId" ON "ContractMilestone" ("contractId");

CREATE TABLE IF NOT EXISTS "CopilotThread" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "title" TEXT,
  "status" TEXT DEFAULT 'active',
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_copilot_thread_userId" ON "CopilotThread" ("userId");

CREATE TABLE IF NOT EXISTS "CopilotMessage" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "threadId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_copilot_message_threadId" ON "CopilotMessage" ("threadId");

CREATE TABLE IF NOT EXISTS "CpqApprovalRule" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "conditions" JSONB,
  "approvers" JSONB,
  "active" BOOLEAN DEFAULT TRUE,
  "priority" INTEGER DEFAULT 0,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "CustomCode" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "language" TEXT DEFAULT 'javascript',
  "code" TEXT,
  "triggerType" TEXT,
  "module" TEXT,
  "active" BOOLEAN DEFAULT FALSE,
  "description" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_custom_code_active" ON "CustomCode" ("active");

CREATE TABLE IF NOT EXISTS "CustomCodeVersion" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "customCodeId" TEXT NOT NULL,
  "version" INTEGER DEFAULT 1,
  "code" TEXT,
  "changelog" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_custom_code_version_customCodeId" ON "CustomCodeVersion" ("customCodeId");

CREATE TABLE IF NOT EXISTS "CustomCodeExecution" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "customCodeId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "duration" INTEGER,
  "output" TEXT,
  "error" TEXT,
  "userId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_custom_code_execution_customCodeId" ON "CustomCodeExecution" ("customCodeId");

CREATE TABLE IF NOT EXISTS "CustomCodeLog" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "customCodeId" TEXT NOT NULL,
  "level" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_custom_code_log_customCodeId" ON "CustomCodeLog" ("customCodeId");

CREATE TABLE IF NOT EXISTS "CustomComponentVersion" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "customComponentId" TEXT NOT NULL,
  "version" INTEGER DEFAULT 1,
  "markup" TEXT,
  "script" TEXT,
  "styles" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_custom_component_version_customComponentId" ON "CustomComponentVersion" ("customComponentId");

CREATE TABLE IF NOT EXISTS "CustomRecord" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "customObjectId" TEXT NOT NULL,
  "data" JSONB,
  "createdById" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_custom_record_customObjectId" ON "CustomRecord" ("customObjectId");
CREATE INDEX IF NOT EXISTS "idx_custom_record_createdById" ON "CustomRecord" ("createdById");

CREATE TABLE IF NOT EXISTS "DealCompetitor" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "strengths" TEXT,
  "weaknesses" TEXT,
  "status" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_deal_competitor_dealId" ON "DealCompetitor" ("dealId");

CREATE TABLE IF NOT EXISTS "Deployment" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "environmentId" TEXT NOT NULL,
  "status" TEXT DEFAULT 'Pending',
  "type" TEXT,
  "metadata" JSONB,
  "rollbackOfId" TEXT,
  "userId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_deployment_environmentId" ON "Deployment" ("environmentId");

CREATE TABLE IF NOT EXISTS "EmailRoutingRule" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "condition" JSONB,
  "assignToId" TEXT,
  "priority" INTEGER DEFAULT 0,
  "caseType" TEXT,
  "active" BOOLEAN DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "EmailToCaseConfig" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "enabled" BOOLEAN DEFAULT TRUE,
  "defaultPriority" TEXT DEFAULT 'Medium',
  "defaultStatus" TEXT DEFAULT 'New',
  "autoResponse" BOOLEAN DEFAULT TRUE,
  "routingAddress" TEXT,
  "maxEmailsPerHour" INTEGER,
  "spamFilter" BOOLEAN DEFAULT TRUE,
  "threadingEnabled" BOOLEAN DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "EntitlementProcess" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "entitlementId" TEXT NOT NULL,
  "steps" JSONB,
  "active" BOOLEAN DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_entitlement_process_entitlementId" ON "EntitlementProcess" ("entitlementId");

CREATE TABLE IF NOT EXISTS "EventAttendee" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "eventId" TEXT NOT NULL,
  "contactId" TEXT,
  "leadId" TEXT,
  "email" TEXT,
  "name" TEXT,
  "status" TEXT DEFAULT 'Invited',
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_event_attendee_eventId" ON "EventAttendee" ("eventId");

CREATE TABLE IF NOT EXISTS "ExportJob" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "module" TEXT NOT NULL,
  "format" TEXT DEFAULT 'csv',
  "status" TEXT DEFAULT 'Queued',
  "filters" JSONB,
  "filePath" TEXT,
  "recordCount" INTEGER,
  "userId" TEXT NOT NULL,
  "completedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_export_job_userId" ON "ExportJob" ("userId");

CREATE TABLE IF NOT EXISTS "FeedLike" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "feedItemId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_feed_like_feedItemId_userId" ON "FeedLike" ("feedItemId", "userId");
CREATE INDEX IF NOT EXISTS "idx_feed_like_feedItemId" ON "FeedLike" ("feedItemId");

CREATE TABLE IF NOT EXISTS "FlowElement" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "flowDefinitionId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "name" TEXT,
  "config" JSONB,
  "position" JSONB,
  "connections" JSONB,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_flow_element_flowDefinitionId" ON "FlowElement" ("flowDefinitionId");

CREATE TABLE IF NOT EXISTS "FlowExecution" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "flowDefinitionId" TEXT NOT NULL,
  "status" TEXT DEFAULT 'Running',
  "triggerRecordId" TEXT,
  "steps" JSONB,
  "error" TEXT,
  "startedAt" TIMESTAMPTZ DEFAULT NOW(),
  "completedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_flow_execution_flowDefinitionId" ON "FlowExecution" ("flowDefinitionId");
CREATE INDEX IF NOT EXISTS "idx_flow_execution_status" ON "FlowExecution" ("status");

CREATE TABLE IF NOT EXISTS "InstalledApp" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "appId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "settings" JSONB,
  "status" TEXT DEFAULT 'Active',
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_installed_app_appId_userId" ON "InstalledApp" ("appId", "userId");
CREATE INDEX IF NOT EXISTS "idx_installed_app_userId" ON "InstalledApp" ("userId");

CREATE TABLE IF NOT EXISTS "IntegrationFieldMapping" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "integrationId" TEXT NOT NULL,
  "sourceField" TEXT NOT NULL,
  "targetField" TEXT NOT NULL,
  "transform" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_integration_field_mapping_integrationId" ON "IntegrationFieldMapping" ("integrationId");

CREATE TABLE IF NOT EXISTS "IpRule" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "ip" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "reason" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_ip_rule_ip" ON "IpRule" ("ip");
CREATE INDEX IF NOT EXISTS "idx_ip_rule_type" ON "IpRule" ("type");

CREATE TABLE IF NOT EXISTS "Journey" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" TEXT DEFAULT 'Draft',
  "steps" JSONB,
  "enrolledCount" INTEGER DEFAULT 0,
  "segmentId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_journey_status" ON "Journey" ("status");

CREATE TABLE IF NOT EXISTS "MacroExecution" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "macroId" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_macro_execution_macroId" ON "MacroExecution" ("macroId");

CREATE TABLE IF NOT EXISTS "MarketplaceListing" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "appId" TEXT NOT NULL,
  "featured" BOOLEAN DEFAULT FALSE,
  "badge" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_marketplace_listing_appId" ON "MarketplaceListing" ("appId");

CREATE TABLE IF NOT EXISTS "MarketplaceReview" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "appId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "rating" INTEGER NOT NULL,
  "title" TEXT,
  "body" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_marketplace_review_appId" ON "MarketplaceReview" ("appId");
CREATE INDEX IF NOT EXISTS "idx_marketplace_review_userId" ON "MarketplaceReview" ("userId");

CREATE TABLE IF NOT EXISTS "MonitoringAlertRule" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "metric" TEXT NOT NULL,
  "condition" TEXT NOT NULL,
  "threshold" DOUBLE PRECISION NOT NULL,
  "channel" TEXT,
  "active" BOOLEAN DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "OmnichannelQueue" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "channels" JSONB,
  "priority" INTEGER DEFAULT 0,
  "active" BOOLEAN DEFAULT TRUE,
  "routingType" TEXT DEFAULT 'roundRobin',
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "OmnichannelItem" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "queueId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "referenceId" TEXT,
  "status" TEXT DEFAULT 'Pending',
  "priority" INTEGER DEFAULT 0,
  "assignedTo" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_omnichannel_item_queueId" ON "OmnichannelItem" ("queueId");
CREATE INDEX IF NOT EXISTS "idx_omnichannel_item_status" ON "OmnichannelItem" ("status");
CREATE INDEX IF NOT EXISTS "idx_omnichannel_item_assignedTo" ON "OmnichannelItem" ("assignedTo");

CREATE TABLE IF NOT EXISTS "PushPreference" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "deals" BOOLEAN DEFAULT TRUE,
  "cases" BOOLEAN DEFAULT TRUE,
  "mentions" BOOLEAN DEFAULT TRUE,
  "approvals" BOOLEAN DEFAULT TRUE,
  "tasks" BOOLEAN DEFAULT TRUE,
  "quietHoursStart" TEXT,
  "quietHoursEnd" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_push_preference_userId" ON "PushPreference" ("userId");

CREATE TABLE IF NOT EXISTS "QuoteVersion" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "quoteId" TEXT NOT NULL,
  "version" INTEGER DEFAULT 1,
  "data" JSONB,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_quote_version_quoteId" ON "QuoteVersion" ("quoteId");

CREATE TABLE IF NOT EXISTS "SalesPathStage" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "salesPathId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "position" INTEGER DEFAULT 0,
  "guidance" TEXT,
  "fields" JSONB,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_sales_path_stage_salesPathId" ON "SalesPathStage" ("salesPathId");

CREATE TABLE IF NOT EXISTS "ScheduledExport" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "format" TEXT DEFAULT 'csv',
  "filters" JSONB,
  "schedule" TEXT,
  "userId" TEXT NOT NULL,
  "active" BOOLEAN DEFAULT TRUE,
  "lastRunAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_scheduled_export_userId" ON "ScheduledExport" ("userId");

CREATE TABLE IF NOT EXISTS "SearchHistory" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "query" TEXT NOT NULL,
  "module" TEXT,
  "results" INTEGER DEFAULT 0,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_search_history_userId" ON "SearchHistory" ("userId");

CREATE TABLE IF NOT EXISTS "Segment" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "criteria" JSONB,
  "memberCount" INTEGER DEFAULT 0,
  "lastEvaluatedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_segment_name" ON "Segment" ("name");

CREATE TABLE IF NOT EXISTS "SubscriptionUsage" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "subscriptionId" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "quantity" DOUBLE PRECISION DEFAULT 0,
  "overage" DOUBLE PRECISION DEFAULT 0,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_subscription_usage_subscriptionId" ON "SubscriptionUsage" ("subscriptionId");

CREATE TABLE IF NOT EXISTS "SurveyQuestion" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "surveyId" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "type" TEXT DEFAULT 'text',
  "options" JSONB,
  "required" BOOLEAN DEFAULT FALSE,
  "position" INTEGER DEFAULT 0,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_survey_question_surveyId" ON "SurveyQuestion" ("surveyId");

CREATE TABLE IF NOT EXISTS "SyncLog" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "integrationId" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "recordsTotal" INTEGER DEFAULT 0,
  "recordsOk" INTEGER DEFAULT 0,
  "recordsFailed" INTEGER DEFAULT 0,
  "errors" JSONB,
  "startedAt" TIMESTAMPTZ DEFAULT NOW(),
  "completedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_sync_log_integrationId" ON "SyncLog" ("integrationId");

CREATE TABLE IF NOT EXISTS "TimelineEvent" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "parentModule" TEXT NOT NULL,
  "parentId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT,
  "body" TEXT,
  "userId" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_timeline_event_parentModule_parentId" ON "TimelineEvent" ("parentModule", "parentId");
CREATE INDEX IF NOT EXISTS "idx_timeline_event_createdAt" ON "TimelineEvent" ("createdAt");

CREATE TABLE IF NOT EXISTS "WebToCaseConfig" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "fields" JSONB,
  "recaptchaEnabled" BOOLEAN DEFAULT FALSE,
  "successMessage" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "Event" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "type" TEXT,
  "description" TEXT,
  "startDate" TIMESTAMPTZ,
  "endDate" TIMESTAMPTZ,
  "location" TEXT,
  "status" TEXT DEFAULT 'Planned',
  "maxAttendees" INTEGER,
  "campaignId" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_event_startDate" ON "Event" ("startDate");
CREATE INDEX IF NOT EXISTS "idx_event_status" ON "Event" ("status");

CREATE TABLE IF NOT EXISTS "Flow" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "type" TEXT,
  "module" TEXT,
  "status" TEXT DEFAULT 'Draft',
  "version" INTEGER DEFAULT 1,
  "triggerType" TEXT,
  "description" TEXT,
  "config" JSONB,
  "active" BOOLEAN DEFAULT FALSE,
  "createdById" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_flow_status" ON "Flow" ("status");
CREATE INDEX IF NOT EXISTS "idx_flow_module" ON "Flow" ("module");

CREATE TABLE IF NOT EXISTS "Integration" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "type" TEXT,
  "provider" TEXT,
  "status" TEXT DEFAULT 'Active',
  "config" JSONB,
  "credentials" JSONB,
  "lastSyncAt" TIMESTAMPTZ,
  "syncFrequency" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_integration_status" ON "Integration" ("status");

CREATE TABLE IF NOT EXISTS "Partner" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "type" TEXT,
  "tier" TEXT DEFAULT 'Registered',
  "status" TEXT DEFAULT 'Active',
  "contactEmail" TEXT,
  "phone" TEXT,
  "website" TEXT,
  "description" TEXT,
  "accountId" TEXT,
  "certifications" JSONB,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_partner_tier" ON "Partner" ("tier");
CREATE INDEX IF NOT EXISTS "idx_partner_status" ON "Partner" ("status");

CREATE TABLE IF NOT EXISTS "Team" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "type" TEXT,
  "managerId" TEXT,
  "active" BOOLEAN DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_team_active" ON "Team" ("active");

CREATE TABLE IF NOT EXISTS "TeamMember" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "teamId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" TEXT DEFAULT 'Member',
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_team_member_teamId_userId" ON "TeamMember" ("teamId", "userId");
CREATE INDEX IF NOT EXISTS "idx_team_member_teamId" ON "TeamMember" ("teamId");
CREATE INDEX IF NOT EXISTS "idx_team_member_userId" ON "TeamMember" ("userId");

CREATE TABLE IF NOT EXISTS "PriceBookEntry" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "priceBookId" TEXT,
  "productId" TEXT NOT NULL,
  "unitPrice" DOUBLE PRECISION NOT NULL,
  "currency" TEXT DEFAULT 'USD',
  "active" BOOLEAN DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_price_book_entry_productId" ON "PriceBookEntry" ("productId");
CREATE INDEX IF NOT EXISTS "idx_price_book_entry_priceBookId" ON "PriceBookEntry" ("priceBookId");

CREATE TABLE IF NOT EXISTS "CalendarEvent" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "title" TEXT NOT NULL,
  "description" TEXT,
  "location" TEXT,
  "eventType" TEXT DEFAULT 'Meeting',
  "status" TEXT DEFAULT 'Planned',
  "startAt" TIMESTAMPTZ NOT NULL,
  "endAt" TIMESTAMPTZ NOT NULL,
  "allDay" BOOLEAN DEFAULT FALSE,
  "timezone" TEXT DEFAULT 'UTC',
  "isRecurring" BOOLEAN DEFAULT FALSE,
  "rrule" TEXT,
  "recurrenceEnd" TIMESTAMPTZ,
  "parentEventId" TEXT,
  "originalStart" TIMESTAMPTZ,
  "isException" BOOLEAN DEFAULT FALSE,
  "isCancelled" BOOLEAN DEFAULT FALSE,
  "ownerId" TEXT,
  "accountId" TEXT,
  "contactId" TEXT,
  "dealId" TEXT,
  "caseId" TEXT,
  "leadId" TEXT,
  "parentModule" TEXT,
  "parentId" TEXT,
  "visibility" TEXT DEFAULT 'Default',
  "color" TEXT,
  "meetingUrl" TEXT,
  "externalUid" TEXT UNIQUE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_calendar_event_ownerId" ON "CalendarEvent" ("ownerId");
CREATE INDEX IF NOT EXISTS "idx_calendar_event_startAt" ON "CalendarEvent" ("startAt");
CREATE INDEX IF NOT EXISTS "idx_calendar_event_endAt" ON "CalendarEvent" ("endAt");
CREATE INDEX IF NOT EXISTS "idx_calendar_event_eventType" ON "CalendarEvent" ("eventType");
CREATE INDEX IF NOT EXISTS "idx_calendar_event_parentEventId" ON "CalendarEvent" ("parentEventId");
CREATE INDEX IF NOT EXISTS "idx_calendar_event_parentModule_parentId" ON "CalendarEvent" ("parentModule", "parentId");
CREATE INDEX IF NOT EXISTS "idx_calendar_event_startAt_endAt" ON "CalendarEvent" ("startAt", "endAt");

CREATE TABLE IF NOT EXISTS "EventInvitee" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "eventId" TEXT NOT NULL,
  "userId" TEXT,
  "contactId" TEXT,
  "leadId" TEXT,
  "email" TEXT,
  "name" TEXT,
  "role" TEXT DEFAULT 'Required',
  "responseStatus" TEXT DEFAULT 'NeedsAction',
  "respondedAt" TIMESTAMPTZ,
  "comment" TEXT,
  "isOrganizer" BOOLEAN DEFAULT FALSE,
  "notifiedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_event_invitee_eventId" ON "EventInvitee" ("eventId");
CREATE INDEX IF NOT EXISTS "idx_event_invitee_userId" ON "EventInvitee" ("userId");
CREATE INDEX IF NOT EXISTS "idx_event_invitee_contactId" ON "EventInvitee" ("contactId");
CREATE INDEX IF NOT EXISTS "idx_event_invitee_responseStatus" ON "EventInvitee" ("responseStatus");

CREATE TABLE IF NOT EXISTS "Reminder" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "eventId" TEXT,
  "activityId" TEXT,
  "userId" TEXT NOT NULL,
  "method" TEXT DEFAULT 'Popup',
  "minutesBefore" INTEGER DEFAULT 15,
  "triggerAt" TIMESTAMPTZ NOT NULL,
  "status" TEXT DEFAULT 'Pending',
  "sentAt" TIMESTAMPTZ,
  "dismissedAt" TIMESTAMPTZ,
  "snoozedUntil" TIMESTAMPTZ,
  "message" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_reminder_userId_status" ON "Reminder" ("userId", "status");
CREATE INDEX IF NOT EXISTS "idx_reminder_triggerAt" ON "Reminder" ("triggerAt");
CREATE INDEX IF NOT EXISTS "idx_reminder_eventId" ON "Reminder" ("eventId");

CREATE TABLE IF NOT EXISTS "CalendarResource" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "resourceType" TEXT DEFAULT 'Room',
  "description" TEXT,
  "location" TEXT,
  "capacity" INTEGER,
  "active" BOOLEAN DEFAULT TRUE,
  "requiresApproval" BOOLEAN DEFAULT FALSE,
  "approverId" TEXT,
  "costPerHour" DOUBLE PRECISION,
  "attributes" JSONB,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_calendar_resource_resourceType" ON "CalendarResource" ("resourceType");
CREATE INDEX IF NOT EXISTS "idx_calendar_resource_active" ON "CalendarResource" ("active");

CREATE TABLE IF NOT EXISTS "ResourceBooking" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "resourceId" TEXT NOT NULL,
  "eventId" TEXT,
  "bookedById" TEXT NOT NULL,
  "startAt" TIMESTAMPTZ NOT NULL,
  "endAt" TIMESTAMPTZ NOT NULL,
  "status" TEXT DEFAULT 'Confirmed',
  "purpose" TEXT,
  "approvedById" TEXT,
  "approvedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_resource_booking_resourceId_startAt" ON "ResourceBooking" ("resourceId", "startAt");
CREATE INDEX IF NOT EXISTS "idx_resource_booking_eventId" ON "ResourceBooking" ("eventId");
CREATE INDEX IF NOT EXISTS "idx_resource_booking_bookedById" ON "ResourceBooking" ("bookedById");
CREATE INDEX IF NOT EXISTS "idx_resource_booking_status" ON "ResourceBooking" ("status");

CREATE TABLE IF NOT EXISTS "CalendarFeed" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "token" TEXT UNIQUE NOT NULL,
  "name" TEXT DEFAULT 'My Calendar',
  "eventTypes" JSONB,
  "includeDeclined" BOOLEAN DEFAULT FALSE,
  "active" BOOLEAN DEFAULT TRUE,
  "lastAccessAt" TIMESTAMPTZ,
  "accessCount" INTEGER DEFAULT 0,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_calendar_feed_userId" ON "CalendarFeed" ("userId");
CREATE INDEX IF NOT EXISTS "idx_calendar_feed_token" ON "CalendarFeed" ("token");

CREATE TABLE IF NOT EXISTS "WorkingHours" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" TEXT,
  "dayOfWeek" INTEGER NOT NULL,
  "startMinute" INTEGER DEFAULT 540,
  "endMinute" INTEGER DEFAULT 1020,
  "isWorkingDay" BOOLEAN DEFAULT TRUE,
  "timezone" TEXT DEFAULT 'UTC',
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_working_hours_userId_dayOfWeek" ON "WorkingHours" ("userId", "dayOfWeek");
CREATE INDEX IF NOT EXISTS "idx_working_hours_userId" ON "WorkingHours" ("userId");

CREATE TABLE IF NOT EXISTS "BusinessHours" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "timezone" TEXT DEFAULT 'UTC',
  "isDefault" BOOLEAN DEFAULT FALSE,
  "active" BOOLEAN DEFAULT TRUE,
  "schedule" JSONB
);

CREATE TABLE IF NOT EXISTS "Project" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "code" TEXT,
  "description" TEXT,
  "status" TEXT DEFAULT 'Draft',
  "priority" TEXT DEFAULT 'Medium',
  "health" TEXT DEFAULT 'Green',
  "startDate" TIMESTAMPTZ,
  "endDate" TIMESTAMPTZ,
  "actualStart" TIMESTAMPTZ,
  "actualEnd" TIMESTAMPTZ,
  "percentComplete" INTEGER DEFAULT 0,
  "budget" DOUBLE PRECISION,
  "actualCost" DOUBLE PRECISION DEFAULT 0,
  "estimatedHours" DOUBLE PRECISION,
  "actualHours" DOUBLE PRECISION DEFAULT 0,
  "currency" TEXT DEFAULT 'USD',
  "managerId" TEXT,
  "ownerId" TEXT,
  "accountId" TEXT,
  "dealId" TEXT,
  "contactId" TEXT,
  "templateId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_project_status" ON "Project" ("status");
CREATE INDEX IF NOT EXISTS "idx_project_managerId" ON "Project" ("managerId");
CREATE INDEX IF NOT EXISTS "idx_project_accountId" ON "Project" ("accountId");
CREATE INDEX IF NOT EXISTS "idx_project_startDate_endDate" ON "Project" ("startDate", "endDate");

CREATE TABLE IF NOT EXISTS "ProjectTask" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" TEXT DEFAULT 'NotStarted',
  "priority" TEXT DEFAULT 'Medium',
  "taskType" TEXT DEFAULT 'Task',
  "startDate" TIMESTAMPTZ,
  "endDate" TIMESTAMPTZ,
  "actualStart" TIMESTAMPTZ,
  "actualEnd" TIMESTAMPTZ,
  "durationDays" DOUBLE PRECISION,
  "percentComplete" INTEGER DEFAULT 0,
  "estimatedHours" DOUBLE PRECISION,
  "actualHours" DOUBLE PRECISION DEFAULT 0,
  "parentTaskId" TEXT,
  "sortOrder" INTEGER DEFAULT 0,
  "wbsCode" TEXT,
  "assignedToId" TEXT,
  "milestoneId" TEXT,
  "isCriticalPath" BOOLEAN DEFAULT FALSE,
  "slackDays" DOUBLE PRECISION,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_project_task_projectId" ON "ProjectTask" ("projectId");
CREATE INDEX IF NOT EXISTS "idx_project_task_parentTaskId" ON "ProjectTask" ("parentTaskId");
CREATE INDEX IF NOT EXISTS "idx_project_task_assignedToId" ON "ProjectTask" ("assignedToId");
CREATE INDEX IF NOT EXISTS "idx_project_task_status" ON "ProjectTask" ("status");
CREATE INDEX IF NOT EXISTS "idx_project_task_startDate_endDate" ON "ProjectTask" ("startDate", "endDate");

CREATE TABLE IF NOT EXISTS "TaskDependency" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "predecessorId" TEXT NOT NULL,
  "successorId" TEXT NOT NULL,
  "dependencyType" TEXT DEFAULT 'FS',
  "lagDays" DOUBLE PRECISION DEFAULT 0,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_task_dependency_predecessorId_successorId" ON "TaskDependency" ("predecessorId", "successorId");
CREATE INDEX IF NOT EXISTS "idx_task_dependency_predecessorId" ON "TaskDependency" ("predecessorId");
CREATE INDEX IF NOT EXISTS "idx_task_dependency_successorId" ON "TaskDependency" ("successorId");

CREATE TABLE IF NOT EXISTS "ProjectMilestone" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "dueDate" TIMESTAMPTZ,
  "completedAt" TIMESTAMPTZ,
  "status" TEXT DEFAULT 'Pending',
  "isBillable" BOOLEAN DEFAULT FALSE,
  "amount" DOUBLE PRECISION,
  "sortOrder" INTEGER DEFAULT 0,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_project_milestone_projectId" ON "ProjectMilestone" ("projectId");
CREATE INDEX IF NOT EXISTS "idx_project_milestone_dueDate" ON "ProjectMilestone" ("dueDate");

CREATE TABLE IF NOT EXISTS "ProjectResource" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" TEXT DEFAULT 'Member',
  "allocationPct" INTEGER DEFAULT 100,
  "hourlyRate" DOUBLE PRECISION,
  "startDate" TIMESTAMPTZ,
  "endDate" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_project_resource_projectId_userId" ON "ProjectResource" ("projectId", "userId");
CREATE INDEX IF NOT EXISTS "idx_project_resource_projectId" ON "ProjectResource" ("projectId");
CREATE INDEX IF NOT EXISTS "idx_project_resource_userId" ON "ProjectResource" ("userId");

CREATE TABLE IF NOT EXISTS "TimeEntry" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId" TEXT,
  "taskId" TEXT,
  "userId" TEXT NOT NULL,
  "entryDate" TIMESTAMPTZ NOT NULL,
  "hours" DOUBLE PRECISION NOT NULL,
  "description" TEXT,
  "billable" BOOLEAN DEFAULT TRUE,
  "billed" BOOLEAN DEFAULT FALSE,
  "hourlyRate" DOUBLE PRECISION,
  "approvedById" TEXT,
  "approvedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_time_entry_projectId" ON "TimeEntry" ("projectId");
CREATE INDEX IF NOT EXISTS "idx_time_entry_taskId" ON "TimeEntry" ("taskId");
CREATE INDEX IF NOT EXISTS "idx_time_entry_userId_entryDate" ON "TimeEntry" ("userId", "entryDate");

CREATE TABLE IF NOT EXISTS "ProjectTemplate" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "category" TEXT,
  "defaultDurationDays" INTEGER,
  "estimatedHours" DOUBLE PRECISION,
  "active" BOOLEAN DEFAULT TRUE,
  "usageCount" INTEGER DEFAULT 0,
  "createdById" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_project_template_active" ON "ProjectTemplate" ("active");

CREATE TABLE IF NOT EXISTS "TaskTemplate" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectTemplateId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "taskType" TEXT DEFAULT 'Task',
  "offsetDays" INTEGER DEFAULT 0,
  "durationDays" DOUBLE PRECISION DEFAULT 1,
  "estimatedHours" DOUBLE PRECISION,
  "defaultRole" TEXT,
  "sortOrder" INTEGER DEFAULT 0,
  "parentKey" TEXT,
  "templateKey" TEXT,
  "dependsOnKeys" JSONB,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_task_template_projectTemplateId" ON "TaskTemplate" ("projectTemplateId");

CREATE TABLE IF NOT EXISTS "SecurityGroup" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT UNIQUE NOT NULL,
  "description" TEXT,
  "isNonInheritable" BOOLEAN DEFAULT FALSE,
  "isPrimaryGroup" BOOLEAN DEFAULT FALSE,
  "autoAssign" BOOLEAN DEFAULT FALSE,
  "active" BOOLEAN DEFAULT TRUE,
  "parentGroupId" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_security_group_active" ON "SecurityGroup" ("active");
CREATE INDEX IF NOT EXISTS "idx_security_group_parentGroupId" ON "SecurityGroup" ("parentGroupId");

CREATE TABLE IF NOT EXISTS "SecurityGroupUser" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "securityGroupId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "isGroupAdmin" BOOLEAN DEFAULT FALSE,
  "primaryGroup" BOOLEAN DEFAULT FALSE,
  "addedById" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_security_group_user_securityGroupId_userId" ON "SecurityGroupUser" ("securityGroupId", "userId");
CREATE INDEX IF NOT EXISTS "idx_security_group_user_userId" ON "SecurityGroupUser" ("userId");
CREATE INDEX IF NOT EXISTS "idx_security_group_user_securityGroupId" ON "SecurityGroupUser" ("securityGroupId");

CREATE TABLE IF NOT EXISTS "SecurityGroupRecord" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "securityGroupId" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "accessLevel" TEXT DEFAULT 'Full',
  "assignedById" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_security_group_record_securityGroupId_module_recordId" ON "SecurityGroupRecord" ("securityGroupId", "module", "recordId");
CREATE INDEX IF NOT EXISTS "idx_security_group_record_module_recordId" ON "SecurityGroupRecord" ("module", "recordId");
CREATE INDEX IF NOT EXISTS "idx_security_group_record_securityGroupId" ON "SecurityGroupRecord" ("securityGroupId");

CREATE TABLE IF NOT EXISTS "SecurityGroupRole" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "securityGroupId" TEXT NOT NULL,
  "roleId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_security_group_role_securityGroupId_roleId" ON "SecurityGroupRole" ("securityGroupId", "roleId");
CREATE INDEX IF NOT EXISTS "idx_security_group_role_roleId" ON "SecurityGroupRole" ("roleId");

CREATE TABLE IF NOT EXISTS "SecurityGroupRule" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "conditions" JSONB
);

CREATE TABLE IF NOT EXISTS "Favorite" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "recordName" TEXT,
  "recordUrl" TEXT,
  "sortOrder" INTEGER DEFAULT 0,
  "pinned" BOOLEAN DEFAULT FALSE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_favorite_userId_module_recordId" ON "Favorite" ("userId", "module", "recordId");
CREATE INDEX IF NOT EXISTS "idx_favorite_userId_module" ON "Favorite" ("userId", "module");
CREATE INDEX IF NOT EXISTS "idx_favorite_userId_pinned" ON "Favorite" ("userId", "pinned");

CREATE TABLE IF NOT EXISTS "RecentlyViewed" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "recordName" TEXT,
  "action" TEXT DEFAULT 'view',
  "viewCount" INTEGER DEFAULT 1,
  "firstSeen" TIMESTAMPTZ DEFAULT NOW(),
  "viewedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_recently_viewed_userId_module_recordId" ON "RecentlyViewed" ("userId", "module", "recordId");
CREATE INDEX IF NOT EXISTS "idx_recently_viewed_userId_viewedAt" ON "RecentlyViewed" ("userId", "viewedAt");
CREATE INDEX IF NOT EXISTS "idx_recently_viewed_module_recordId" ON "RecentlyViewed" ("module", "recordId");

CREATE TABLE IF NOT EXISTS "ViewStat" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "module" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "totalViews" INTEGER DEFAULT 0,
  "uniqueUsers" INTEGER DEFAULT 0,
  "lastViewedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_view_stat_module_recordId" ON "ViewStat" ("module", "recordId");
CREATE INDEX IF NOT EXISTS "idx_view_stat_module_totalViews" ON "ViewStat" ("module", "totalViews");

CREATE TABLE IF NOT EXISTS "SearchIndex" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "module" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "subtitle" TEXT,
  "body" TEXT,
  "tokens" TEXT NOT NULL,
  "tokenCount" INTEGER DEFAULT 0,
  "keywords" TEXT,
  "ownerId" TEXT,
  "status" TEXT,
  "boost" DOUBLE PRECISION DEFAULT 1.0,
  "recordUpdatedAt" TIMESTAMPTZ,
  "indexedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_search_index_module_recordId" ON "SearchIndex" ("module", "recordId");
CREATE INDEX IF NOT EXISTS "idx_search_index_module" ON "SearchIndex" ("module");
CREATE INDEX IF NOT EXISTS "idx_search_index_indexedAt" ON "SearchIndex" ("indexedAt");

CREATE TABLE IF NOT EXISTS "SearchPosting" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "indexId" TEXT NOT NULL,
  "term" TEXT NOT NULL,
  "field" TEXT DEFAULT 'body',
  "frequency" INTEGER DEFAULT 1,
  "positions" TEXT
);
CREATE INDEX IF NOT EXISTS "idx_search_posting_term" ON "SearchPosting" ("term");
CREATE INDEX IF NOT EXISTS "idx_search_posting_indexId" ON "SearchPosting" ("indexId");
CREATE INDEX IF NOT EXISTS "idx_search_posting_term_field" ON "SearchPosting" ("term", "field");

CREATE TABLE IF NOT EXISTS "SearchTermStat" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "term" TEXT UNIQUE NOT NULL,
  "docCount" INTEGER DEFAULT 0,
  "totalFreq" INTEGER DEFAULT 0,
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_search_term_stat_docCount" ON "SearchTermStat" ("docCount");

CREATE TABLE IF NOT EXISTS "SearchSynonym" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "term" TEXT NOT NULL,
  "synonym" TEXT NOT NULL,
  "twoWay" BOOLEAN DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_search_synonym_term_synonym" ON "SearchSynonym" ("term", "synonym");
CREATE INDEX IF NOT EXISTS "idx_search_synonym_term" ON "SearchSynonym" ("term");

CREATE TABLE IF NOT EXISTS "SearchQueryLog" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" TEXT,
  "query" TEXT NOT NULL,
  "normalized" TEXT,
  "resultCount" INTEGER DEFAULT 0,
  "durationMs" INTEGER DEFAULT 0,
  "clickedModule" TEXT,
  "clickedRecordId" TEXT,
  "clickedRank" INTEGER,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_search_query_log_normalized" ON "SearchQueryLog" ("normalized");
CREATE INDEX IF NOT EXISTS "idx_search_query_log_createdAt" ON "SearchQueryLog" ("createdAt");

CREATE TABLE IF NOT EXISTS "SearchIndexQueue" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "module" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "operation" TEXT DEFAULT 'upsert',
  "attempts" INTEGER DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_search_index_queue_module_recordId_operation" ON "SearchIndexQueue" ("module", "recordId", "operation");
CREATE INDEX IF NOT EXISTS "idx_search_index_queue_createdAt" ON "SearchIndexQueue" ("createdAt");

CREATE TABLE IF NOT EXISTS "InboundEmailAccount" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "protocol" TEXT DEFAULT 'imap',
  "host" TEXT NOT NULL,
  "port" INTEGER DEFAULT 993,
  "useTls" BOOLEAN DEFAULT TRUE,
  "username" TEXT NOT NULL,
  "password" TEXT NOT NULL,
  "mailbox" TEXT DEFAULT 'INBOX',
  "pollIntervalMinutes" INTEGER DEFAULT 5,
  "status" TEXT DEFAULT 'Idle',
  "lastPolledAt" TIMESTAMPTZ,
  "lastUid" INTEGER DEFAULT 0,
  "lastError" TEXT,
  "autoCreateCase" BOOLEAN DEFAULT TRUE,
  "autoCreateLead" BOOLEAN DEFAULT FALSE,
  "autoReply" BOOLEAN DEFAULT FALSE,
  "autoReplyTemplateId" TEXT,
  "defaultOwnerId" TEXT,
  "defaultTeamId" TEXT,
  "defaultCaseType" TEXT,
  "defaultPriority" TEXT DEFAULT 'Medium',
  "markSeen" BOOLEAN DEFAULT TRUE,
  "deleteAfterImport" BOOLEAN DEFAULT FALSE,
  "maxMessagesPerPoll" INTEGER DEFAULT 50,
  "allowedSenders" TEXT,
  "blockedSenders" TEXT,
  "active" BOOLEAN DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_inbound_email_account_active" ON "InboundEmailAccount" ("active");

CREATE TABLE IF NOT EXISTS "InboundEmailMessage" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "accountId" TEXT NOT NULL,
  "uid" INTEGER,
  "messageId" TEXT,
  "inReplyTo" TEXT,
  "references" TEXT,
  "threadKey" TEXT,
  "fromEmail" TEXT NOT NULL,
  "fromName" TEXT,
  "toEmails" TEXT,
  "ccEmails" TEXT,
  "replyTo" TEXT,
  "subject" TEXT,
  "textBody" TEXT,
  "htmlBody" TEXT,
  "snippet" TEXT,
  "receivedAt" TIMESTAMPTZ DEFAULT NOW(),
  "sizeBytes" INTEGER DEFAULT 0,
  "flags" TEXT,
  "hasAttachments" BOOLEAN DEFAULT FALSE,
  "attachmentCount" INTEGER DEFAULT 0,
  "status" TEXT DEFAULT 'New',
  "matchedModule" TEXT,
  "matchedRecordId" TEXT,
  "createdCaseId" TEXT,
  "createdLeadId" TEXT,
  "appliedRuleId" TEXT,
  "processedAt" TIMESTAMPTZ,
  "error" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_inbound_email_message_accountId_uid" ON "InboundEmailMessage" ("accountId", "uid");
CREATE INDEX IF NOT EXISTS "idx_inbound_email_message_accountId_status" ON "InboundEmailMessage" ("accountId", "status");
CREATE INDEX IF NOT EXISTS "idx_inbound_email_message_threadKey" ON "InboundEmailMessage" ("threadKey");
CREATE INDEX IF NOT EXISTS "idx_inbound_email_message_fromEmail" ON "InboundEmailMessage" ("fromEmail");
CREATE INDEX IF NOT EXISTS "idx_inbound_email_message_messageId" ON "InboundEmailMessage" ("messageId");

CREATE TABLE IF NOT EXISTS "InboundEmailAttachment" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "messageId" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "contentType" TEXT,
  "sizeBytes" INTEGER DEFAULT 0,
  "contentId" TEXT,
  "inline" BOOLEAN DEFAULT FALSE,
  "storagePath" TEXT,
  "documentId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_inbound_email_attachment_messageId" ON "InboundEmailAttachment" ("messageId");

CREATE TABLE IF NOT EXISTS "InboundRoutingRule" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "accountId" TEXT,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "priority" INTEGER DEFAULT 100,
  "conditions" JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS "EmailPollLog" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "accountId" TEXT NOT NULL,
  "startedAt" TIMESTAMPTZ DEFAULT NOW(),
  "finishedAt" TIMESTAMPTZ,
  "durationMs" INTEGER DEFAULT 0,
  "messagesFetched" INTEGER DEFAULT 0,
  "messagesProcessed" INTEGER DEFAULT 0,
  "casesCreated" INTEGER DEFAULT 0,
  "leadsCreated" INTEGER DEFAULT 0,
  "errorCount" INTEGER DEFAULT 0,
  "status" TEXT DEFAULT 'Running',
  "error" TEXT
);
CREATE INDEX IF NOT EXISTS "idx_email_poll_log_accountId_startedAt" ON "EmailPollLog" ("accountId", "startedAt");

CREATE TABLE IF NOT EXISTS "GeocodeCache" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "addressHash" TEXT UNIQUE NOT NULL,
  "rawAddress" TEXT NOT NULL,
  "formattedAddress" TEXT,
  "latitude" DOUBLE PRECISION,
  "longitude" DOUBLE PRECISION,
  "street" TEXT,
  "city" TEXT,
  "region" TEXT,
  "postalCode" TEXT,
  "country" TEXT,
  "countryCode" TEXT,
  "accuracy" TEXT,
  "provider" TEXT DEFAULT 'manual',
  "confidence" DOUBLE PRECISION DEFAULT 0,
  "failed" BOOLEAN DEFAULT FALSE,
  "hitCount" INTEGER DEFAULT 0,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "lastUsedAt" TIMESTAMPTZ DEFAULT NOW(),
  "expiresAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_geocode_cache_latitude_longitude" ON "GeocodeCache" ("latitude", "longitude");
CREATE INDEX IF NOT EXISTS "idx_geocode_cache_city" ON "GeocodeCache" ("city");

CREATE TABLE IF NOT EXISTS "MapArea" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "type" TEXT DEFAULT 'Territory',
  "shape" TEXT DEFAULT 'polygon',
  "polygon" JSONB
);

CREATE TABLE IF NOT EXISTS "MapMarker" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "module" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "sublabel" TEXT,
  "latitude" DOUBLE PRECISION NOT NULL,
  "longitude" DOUBLE PRECISION NOT NULL,
  "geohash" TEXT,
  "markerType" TEXT DEFAULT 'default',
  "color" TEXT DEFAULT '#F5A623',
  "icon" TEXT,
  "addressHash" TEXT,
  "areaId" TEXT,
  "ownerId" TEXT,
  "meta" JSONB,
  "stale" BOOLEAN DEFAULT FALSE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_map_marker_module_recordId" ON "MapMarker" ("module", "recordId");
CREATE INDEX IF NOT EXISTS "idx_map_marker_latitude_longitude" ON "MapMarker" ("latitude", "longitude");
CREATE INDEX IF NOT EXISTS "idx_map_marker_geohash" ON "MapMarker" ("geohash");
CREATE INDEX IF NOT EXISTS "idx_map_marker_module" ON "MapMarker" ("module");
CREATE INDEX IF NOT EXISTS "idx_map_marker_areaId" ON "MapMarker" ("areaId");

CREATE TABLE IF NOT EXISTS "MapLayer" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "description" TEXT,
  "filterJson" JSONB,
  "markerColor" TEXT DEFAULT '#F5A623',
  "markerIcon" TEXT,
  "labelField" TEXT,
  "visible" BOOLEAN DEFAULT TRUE,
  "sortOrder" INTEGER DEFAULT 0,
  "ownerId" TEXT,
  "isShared" BOOLEAN DEFAULT FALSE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_map_layer_module" ON "MapLayer" ("module");

CREATE TABLE IF NOT EXISTS "Prospect" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "salutation" TEXT,
  "firstName" TEXT,
  "lastName" TEXT NOT NULL,
  "fullName" TEXT,
  "title" TEXT,
  "department" TEXT,
  "accountName" TEXT,
  "email" TEXT,
  "altEmail" TEXT,
  "phoneWork" TEXT,
  "phoneMobile" TEXT,
  "phoneOther" TEXT,
  "fax" TEXT,
  "website" TEXT,
  "linkedIn" TEXT,
  "street" TEXT,
  "city" TEXT,
  "state" TEXT,
  "postalCode" TEXT,
  "country" TEXT,
  "latitude" DOUBLE PRECISION,
  "longitude" DOUBLE PRECISION,
  "source" TEXT,
  "sourceDetail" TEXT,
  "status" TEXT DEFAULT 'New',
  "score" INTEGER DEFAULT 0,
  "industry" TEXT,
  "employeeCount" INTEGER,
  "annualRevenue" DOUBLE PRECISION,
  "description" TEXT,
  "emailOptOut" BOOLEAN DEFAULT FALSE,
  "doNotCall" BOOLEAN DEFAULT FALSE,
  "invalidEmail" BOOLEAN DEFAULT FALSE,
  "bouncedCount" INTEGER DEFAULT 0,
  "lastContactedAt" TIMESTAMPTZ,
  "ownerId" TEXT,
  "convertedLeadId" TEXT,
  "convertedContactId" TEXT,
  "convertedAt" TIMESTAMPTZ,
  "duplicateOfId" TEXT,
  "externalId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_prospect_email" ON "Prospect" ("email");
CREATE INDEX IF NOT EXISTS "idx_prospect_status" ON "Prospect" ("status");
CREATE INDEX IF NOT EXISTS "idx_prospect_ownerId" ON "Prospect" ("ownerId");
CREATE INDEX IF NOT EXISTS "idx_prospect_lastName_firstName" ON "Prospect" ("lastName", "firstName");

CREATE TABLE IF NOT EXISTS "ProspectList" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "type" TEXT DEFAULT 'Static',
  "entityModule" TEXT DEFAULT 'Prospect',
  "filterJson" JSONB,
  "memberCount" INTEGER DEFAULT 0,
  "activeCount" INTEGER DEFAULT 0,
  "optedOutCount" INTEGER DEFAULT 0,
  "lastBuiltAt" TIMESTAMPTZ,
  "buildDurationMs" INTEGER DEFAULT 0,
  "ownerId" TEXT,
  "isShared" BOOLEAN DEFAULT FALSE,
  "campaignId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_prospect_list_type" ON "ProspectList" ("type");
CREATE INDEX IF NOT EXISTS "idx_prospect_list_ownerId" ON "ProspectList" ("ownerId");
CREATE INDEX IF NOT EXISTS "idx_prospect_list_campaignId" ON "ProspectList" ("campaignId");

CREATE TABLE IF NOT EXISTS "ProspectListEntry" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "listId" TEXT NOT NULL,
  "prospectId" TEXT,
  "leadId" TEXT,
  "contactId" TEXT,
  "accountId" TEXT,
  "email" TEXT,
  "name" TEXT,
  "entityModule" TEXT DEFAULT 'Prospect',
  "status" TEXT DEFAULT 'Active',
  "addedBy" TEXT,
  "addedVia" TEXT DEFAULT 'manual',
  "addedAt" TIMESTAMPTZ DEFAULT NOW(),
  "removedAt" TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_prospect_list_entry_listId_entityModule_prospectId_leadId_contactId_accountId" ON "ProspectListEntry" ("listId", "entityModule", "prospectId", "leadId", "contactId", "accountId");
CREATE INDEX IF NOT EXISTS "idx_prospect_list_entry_listId_status" ON "ProspectListEntry" ("listId", "status");
CREATE INDEX IF NOT EXISTS "idx_prospect_list_entry_email" ON "ProspectListEntry" ("email");
CREATE INDEX IF NOT EXISTS "idx_prospect_list_entry_prospectId" ON "ProspectListEntry" ("prospectId");

CREATE TABLE IF NOT EXISTS "EmailSuppression" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" TEXT UNIQUE NOT NULL,
  "reason" TEXT DEFAULT 'Unsubscribe',
  "source" TEXT,
  "campaignId" TEXT,
  "notes" TEXT,
  "suppressedAt" TIMESTAMPTZ DEFAULT NOW(),
  "expiresAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_email_suppression_reason" ON "EmailSuppression" ("reason");

CREATE TABLE IF NOT EXISTS "Release" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT UNIQUE NOT NULL,
  "version" TEXT,
  "status" TEXT DEFAULT 'Planned',
  "releaseDate" TIMESTAMPTZ,
  "targetDate" TIMESTAMPTZ,
  "description" TEXT,
  "releaseNotes" TEXT,
  "sortOrder" INTEGER DEFAULT 0,
  "isCurrent" BOOLEAN DEFAULT FALSE,
  "ownerId" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_release_status" ON "Release" ("status");
CREATE INDEX IF NOT EXISTS "idx_release_sortOrder" ON "Release" ("sortOrder");

CREATE TABLE IF NOT EXISTS "Bug" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "bugNumber" INTEGER UNIQUE NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "status" TEXT DEFAULT 'New',
  "priority" TEXT DEFAULT 'Medium',
  "severity" TEXT DEFAULT 'Minor',
  "type" TEXT DEFAULT 'Defect',
  "source" TEXT,
  "resolution" TEXT,
  "category" TEXT,
  "component" TEXT,
  "stepsToReproduce" TEXT,
  "expectedBehavior" TEXT,
  "actualBehavior" TEXT,
  "environment" TEXT,
  "workLog" TEXT,
  "foundInReleaseId" TEXT,
  "fixedInReleaseId" TEXT,
  "assignedToId" TEXT,
  "reportedById" TEXT,
  "accountId" TEXT,
  "contactId" TEXT,
  "caseId" TEXT,
  "productId" TEXT,
  "duplicateOfId" TEXT,
  "parentBugId" TEXT,
  "votes" INTEGER DEFAULT 0,
  "reopenCount" INTEGER DEFAULT 0,
  "estimatedHours" DOUBLE PRECISION,
  "actualHours" DOUBLE PRECISION,
  "dueDate" TIMESTAMPTZ,
  "resolvedAt" TIMESTAMPTZ,
  "closedAt" TIMESTAMPTZ,
  "firstResponseAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_bug_status" ON "Bug" ("status");
CREATE INDEX IF NOT EXISTS "idx_bug_assignedToId" ON "Bug" ("assignedToId");
CREATE INDEX IF NOT EXISTS "idx_bug_priority_severity" ON "Bug" ("priority", "severity");
CREATE INDEX IF NOT EXISTS "idx_bug_fixedInReleaseId" ON "Bug" ("fixedInReleaseId");
CREATE INDEX IF NOT EXISTS "idx_bug_caseId" ON "Bug" ("caseId");

CREATE TABLE IF NOT EXISTS "BugComment" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "bugId" TEXT NOT NULL,
  "userId" TEXT,
  "authorName" TEXT,
  "body" TEXT NOT NULL,
  "isInternal" BOOLEAN DEFAULT FALSE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_bug_comment_bugId" ON "BugComment" ("bugId");

CREATE TABLE IF NOT EXISTS "BugWatcher" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "bugId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "notifyOn" TEXT DEFAULT 'all',
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_bug_watcher_bugId_userId" ON "BugWatcher" ("bugId", "userId");
CREATE INDEX IF NOT EXISTS "idx_bug_watcher_userId" ON "BugWatcher" ("userId");

CREATE TABLE IF NOT EXISTS "BugHistory" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "bugId" TEXT NOT NULL,
  "userId" TEXT,
  "field" TEXT NOT NULL,
  "oldValue" TEXT,
  "newValue" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_bug_history_bugId_createdAt" ON "BugHistory" ("bugId", "createdAt");

CREATE TABLE IF NOT EXISTS "PdfTemplate" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "module" TEXT NOT NULL,
  "templateType" TEXT DEFAULT 'Document',
  "bodyHtml" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "PdfRender" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "templateId" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "storagePath" TEXT,
  "sizeBytes" INTEGER DEFAULT 0,
  "renderedById" TEXT,
  "durationMs" INTEGER DEFAULT 0,
  "status" TEXT DEFAULT 'Success',
  "error" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_pdf_render_templateId" ON "PdfRender" ("templateId");
CREATE INDEX IF NOT EXISTS "idx_pdf_render_module_recordId" ON "PdfRender" ("module", "recordId");

CREATE TABLE IF NOT EXISTS "CustomFieldDef" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "module" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "fieldType" TEXT NOT NULL,
  "description" TEXT,
  "helpText" TEXT,
  "required" BOOLEAN DEFAULT FALSE,
  "unique" BOOLEAN DEFAULT FALSE,
  "defaultValue" TEXT,
  "maxLength" INTEGER,
  "minValue" DOUBLE PRECISION,
  "maxValue" DOUBLE PRECISION,
  "precision" INTEGER DEFAULT 2,
  "picklistId" TEXT,
  "relatedModule" TEXT,
  "formula" TEXT,
  "regex" TEXT,
  "regexMessage" TEXT,
  "auditable" BOOLEAN DEFAULT FALSE,
  "reportable" BOOLEAN DEFAULT TRUE,
  "searchable" BOOLEAN DEFAULT FALSE,
  "readOnly" BOOLEAN DEFAULT FALSE,
  "sortOrder" INTEGER DEFAULT 0,
  "active" BOOLEAN DEFAULT TRUE,
  "createdById" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_custom_field_def_module_name" ON "CustomFieldDef" ("module", "name");
CREATE INDEX IF NOT EXISTS "idx_custom_field_def_module_active" ON "CustomFieldDef" ("module", "active");

CREATE TABLE IF NOT EXISTS "Picklist" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT UNIQUE NOT NULL,
  "label" TEXT NOT NULL,
  "description" TEXT,
  "isGlobal" BOOLEAN DEFAULT TRUE,
  "active" BOOLEAN DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "PicklistValue" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "picklistId" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "color" TEXT,
  "sortOrder" INTEGER DEFAULT 0,
  "isDefault" BOOLEAN DEFAULT FALSE,
  "active" BOOLEAN DEFAULT TRUE,
  "parentValue" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_picklist_value_picklistId_value" ON "PicklistValue" ("picklistId", "value");
CREATE INDEX IF NOT EXISTS "idx_picklist_value_picklistId_active" ON "PicklistValue" ("picklistId", "active");

CREATE TABLE IF NOT EXISTS "LayoutDef" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "module" TEXT NOT NULL,
  "viewType" TEXT DEFAULT 'detail',
  "name" TEXT DEFAULT 'Default',
  "panels" JSONB
);

CREATE TABLE IF NOT EXISTS "Setting" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "key" TEXT UNIQUE NOT NULL,
  "value" TEXT NOT NULL,
  "category" TEXT,
  "updatedById" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_setting_category" ON "Setting" ("category");

CREATE TABLE IF NOT EXISTS "CaseStatusHistory" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "caseId" TEXT NOT NULL,
  "fromStatus" TEXT,
  "toStatus" TEXT NOT NULL,
  "changedById" TEXT,
  "note" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_case_status_history_caseId_createdAt" ON "CaseStatusHistory" ("caseId", "createdAt");

CREATE TABLE IF NOT EXISTS "SignupRequest" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" TEXT NOT NULL,
  "firstName" TEXT,
  "lastName" TEXT,
  "company" TEXT,
  "companySize" TEXT,
  "role" TEXT,
  "phone" TEXT,
  "useCase" TEXT,
  "interestedIn" TEXT DEFAULT 'cloud',
  "status" TEXT DEFAULT 'Pending',
  "verifyTokenHash" TEXT UNIQUE,
  "verifyExpiresAt" TIMESTAMPTZ,
  "verifiedAt" TIMESTAMPTZ,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMPTZ,
  "rejectionReason" TEXT,
  "convertedUserId" TEXT,
  "convertedAt" TIMESTAMPTZ,
  "source" TEXT,
  "utmSource" TEXT,
  "utmCampaign" TEXT,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_signup_request_status" ON "SignupRequest" ("status");
CREATE INDEX IF NOT EXISTS "idx_signup_request_email" ON "SignupRequest" ("email");
CREATE INDEX IF NOT EXISTS "idx_signup_request_createdAt" ON "SignupRequest" ("createdAt");

CREATE TABLE IF NOT EXISTS "UserInvite" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" TEXT NOT NULL,
  "firstName" TEXT,
  "lastName" TEXT,
  "roleId" TEXT,
  "tokenHash" TEXT UNIQUE NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "status" TEXT DEFAULT 'Pending',
  "invitedById" TEXT,
  "acceptedAt" TIMESTAMPTZ,
  "acceptedUserId" TEXT,
  "signupRequestId" TEXT,
  "message" TEXT,
  "resendCount" INTEGER DEFAULT 0,
  "lastSentAt" TIMESTAMPTZ DEFAULT NOW(),
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_user_invite_email" ON "UserInvite" ("email");
CREATE INDEX IF NOT EXISTS "idx_user_invite_status" ON "UserInvite" ("status");
CREATE INDEX IF NOT EXISTS "idx_user_invite_expiresAt" ON "UserInvite" ("expiresAt");
