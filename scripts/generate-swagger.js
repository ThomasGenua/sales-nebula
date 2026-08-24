#!/usr/bin/env node

/**
 * Generate OpenAPI 3.0 spec for Sales Nebula API
 * Run: node scripts/generate-swagger.js
 * Output: src/openapi.json
 */

const fs = require('fs');
const path = require('path');

// ─── SHARED SCHEMAS ───
const schemas = {
  Error: {
    type: 'object',
    properties: {
      error: { type: 'string', description: 'Error message' },
    },
  },
  PaginationMeta: {
    type: 'object',
    properties: {
      total: { type: 'integer' },
      page: { type: 'integer' },
      limit: { type: 'integer' },
      pages: { type: 'integer' },
    },
  },
  Contact: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      firstName: { type: 'string' },
      lastName: { type: 'string' },
      email: { type: 'string', format: 'email' },
      phone: { type: 'string' },
      title: { type: 'string' },
      department: { type: 'string' },
      source: { type: 'string' },
      status: { type: 'string' },
      accountId: { type: 'string', format: 'uuid', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  Lead: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      firstName: { type: 'string' },
      lastName: { type: 'string' },
      email: { type: 'string', format: 'email' },
      company: { type: 'string' },
      title: { type: 'string' },
      source: { type: 'string' },
      status: { type: 'string', enum: ['New', 'Contacted', 'Qualified', 'Unqualified', 'Converted'] },
      rating: { type: 'string' },
      score: { type: 'integer' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  Deal: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      value: { type: 'number' },
      stage: { type: 'string', enum: ['Qualification', 'Discovery', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'] },
      probability: { type: 'integer', minimum: 0, maximum: 100 },
      closeDate: { type: 'string', format: 'date' },
      source: { type: 'string' },
      type: { type: 'string' },
      ownerId: { type: 'string', format: 'uuid' },
      accountId: { type: 'string', format: 'uuid', nullable: true },
      contactId: { type: 'string', format: 'uuid', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  Account: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      industry: { type: 'string' },
      type: { type: 'string' },
      website: { type: 'string' },
      phone: { type: 'string' },
      revenue: { type: 'number' },
      employees: { type: 'integer' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  Report: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      description: { type: 'string', nullable: true },
      module: { type: 'string', enum: ['contacts', 'leads', 'deals', 'accounts', 'activities', 'cases', 'products', 'invoices', 'quotes'] },
      reportType: { type: 'string', enum: ['tabular', 'summary', 'matrix', 'chart'] },
      chartType: { type: 'string', enum: ['bar', 'line', 'pie', 'donut', 'funnel', 'scatter', 'area'], nullable: true },
      columns: { type: 'array', items: { type: 'object' } },
      filters: { type: 'array', items: { $ref: '#/components/schemas/ReportFilter' } },
      groupBy: { type: 'array', items: { type: 'string' } },
      aggregations: { type: 'array', items: { $ref: '#/components/schemas/ReportAggregation' } },
      sortBy: { type: 'array', items: { type: 'object' } },
      limit: { type: 'integer', nullable: true },
      isPublic: { type: 'boolean' },
      createdById: { type: 'string', format: 'uuid' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  ReportFilter: {
    type: 'object',
    properties: {
      field: { type: 'string' },
      operator: { type: 'string', enum: ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'is_null', 'is_not_null', 'between', 'date_after', 'date_before', 'date_between', 'this_month', 'this_quarter', 'this_year', 'last_n_days'] },
      value: {},
    },
    required: ['field', 'operator'],
  },
  ReportAggregation: {
    type: 'object',
    properties: {
      field: { type: 'string' },
      function: { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max'] },
    },
    required: ['field', 'function'],
  },
  ReportResult: {
    type: 'object',
    properties: {
      reportType: { type: 'string' },
      module: { type: 'string' },
      rows: { type: 'array', items: { type: 'object' } },
      totalCount: { type: 'integer' },
      returnedCount: { type: 'integer' },
      chartData: { type: 'array', items: { type: 'object' }, nullable: true },
      summary: { type: 'object', nullable: true },
      totals: { type: 'object', nullable: true },
      executionMs: { type: 'integer' },
      executedAt: { type: 'string', format: 'date-time' },
    },
  },
  User: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      email: { type: 'string', format: 'email' },
      firstName: { type: 'string' },
      lastName: { type: 'string' },
      avatar: { type: 'string', nullable: true },
      active: { type: 'boolean' },
      roleId: { type: 'string', format: 'uuid' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  AuthResponse: {
    type: 'object',
    properties: {
      token: { type: 'string' },
      user: { $ref: '#/components/schemas/User' },
    },
  },
};

// ─── CRUD ENDPOINT GENERATOR ───
function crudPaths(basePath, tag, schema, createRequired = []) {
  const paths = {};
  const ref = `#/components/schemas/${schema}`;

  // List
  paths[basePath] = {
    get: {
      tags: [tag],
      summary: `List ${tag}`,
      parameters: [
        { name: 'search', in: 'query', schema: { type: 'string' } },
        { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
        { name: 'sortBy', in: 'query', schema: { type: 'string' } },
        { name: 'sortDir', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } },
      ],
      responses: {
        200: { description: 'Paginated list', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { $ref: ref } }, meta: { $ref: '#/components/schemas/PaginationMeta' } } } } } },
        401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
      security: [{ bearerAuth: [] }],
    },
    post: {
      tags: [tag],
      summary: `Create ${tag.slice(0, -1)}`,
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: ref } } } },
      responses: {
        201: { description: 'Created', content: { 'application/json': { schema: { $ref: ref } } } },
        400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
      security: [{ bearerAuth: [] }],
    },
  };

  // Single
  paths[`${basePath}/{id}`] = {
    get: {
      tags: [tag],
      summary: `Get ${tag.slice(0, -1)} by ID`,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Success', content: { 'application/json': { schema: { $ref: ref } } } },
        404: { description: 'Not found' },
      },
      security: [{ bearerAuth: [] }],
    },
    put: {
      tags: [tag],
      summary: `Update ${tag.slice(0, -1)}`,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: ref } } } },
      responses: { 200: { description: 'Updated', content: { 'application/json': { schema: { $ref: ref } } } } },
      security: [{ bearerAuth: [] }],
    },
    delete: {
      tags: [tag],
      summary: `Delete ${tag.slice(0, -1)}`,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } } } },
      security: [{ bearerAuth: [] }],
    },
  };

  // Bulk
  paths[`${basePath}/bulk-delete`] = {
    post: {
      tags: [tag],
      summary: `Bulk delete ${tag}`,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] } } } },
      responses: { 200: { description: 'Deleted count', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, deleted: { type: 'integer' } } } } } } },
      security: [{ bearerAuth: [] }],
    },
  };

  paths[`${basePath}/bulk-update`] = {
    post: {
      tags: [tag],
      summary: `Bulk update ${tag}`,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, data: { type: 'object' } }, required: ['ids', 'data'] } } } },
      responses: { 200: { description: 'Updated count' } },
      security: [{ bearerAuth: [] }],
    },
  };

  return paths;
}

// ─── BUILD SPEC ───

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'Sales Nebula CRM API',
    version: '2.0.0',
    description: 'Full-stack CRM API with 25 modules, 100+ endpoints. Enterprise features include Report Builder, Forecasting, CPQ, Approvals, Territory Management, Knowledge Base, and Chatter.',
    contact: { name: 'Sales Nebula', url: 'https://github.com/sales-nebula' },
    license: { name: 'MIT' },
  },
  servers: [
    { url: 'http://localhost:4000', description: 'Development' },
  ],
  tags: [
    { name: 'Auth', description: 'Authentication and authorization' },
    { name: 'OAuth', description: 'Google and Microsoft SSO' },
    { name: 'Contacts', description: 'Contact management' },
    { name: 'Leads', description: 'Lead management and conversion' },
    { name: 'Deals', description: 'Deal pipeline management' },
    { name: 'Accounts', description: 'Account management' },
    { name: 'Activities', description: 'Activities, tasks, and meetings' },
    { name: 'Emails', description: 'Email send and tracking' },
    { name: 'Cases', description: 'Support case management' },
    { name: 'Documents', description: 'File management' },
    { name: 'Campaigns', description: 'Marketing campaigns' },
    { name: 'Products', description: 'Product catalog' },
    { name: 'Quotes', description: 'Quoting and proposals' },
    { name: 'Invoices', description: 'Invoice management' },
    { name: 'Workflows', description: 'Automation workflows' },
    { name: 'Reports', description: 'Report Builder - dynamic queries' },
    { name: 'Forecasts', description: 'Revenue forecasting' },
    { name: 'CPQ', description: 'Configure-Price-Quote' },
    { name: 'Approvals', description: 'Approval processes' },
    { name: 'Territories', description: 'Territory management' },
    { name: 'Knowledge', description: 'Knowledge base articles' },
    { name: 'Chatter', description: 'Social feed and collaboration' },
    { name: 'Formulas', description: 'Computed formula fields' },
    { name: 'Users', description: 'User management' },
    { name: 'Admin', description: 'System administration' },
    { name: 'AI', description: 'AI assistant features' },
  ],
  components: {
    schemas,
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Login via POST /api/auth/login to get a token',
      },
    },
  },
  paths: {},
};

// ─── AUTH PATHS ───
Object.assign(spec.paths, {
  '/api/auth/login': {
    post: {
      tags: ['Auth'], summary: 'Login',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { email: { type: 'string' }, password: { type: 'string' } }, required: ['email', 'password'] } } } },
      responses: { 200: { description: 'JWT token + user', content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthResponse' } } } }, 401: { description: 'Invalid credentials' } },
    },
  },
  '/api/auth/register': {
    post: {
      tags: ['Auth'], summary: 'Register new user',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { email: { type: 'string' }, password: { type: 'string' }, firstName: { type: 'string' }, lastName: { type: 'string' }, roleId: { type: 'string' } }, required: ['email', 'password', 'firstName', 'lastName'] } } } },
      responses: { 201: { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthResponse' } } } }, 400: { description: 'Email exists' } },
    },
  },
  '/api/auth/me': {
    get: {
      tags: ['Auth'], summary: 'Get current user', security: [{ bearerAuth: [] }],
      responses: { 200: { description: 'Current user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } } },
    },
  },
  '/api/oauth/config': {
    get: {
      tags: ['OAuth'], summary: 'Get OAuth provider configuration',
      responses: { 200: { description: 'OAuth config' } },
    },
  },
  '/api/oauth/google': {
    post: {
      tags: ['OAuth'], summary: 'Login with Google',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { credential: { type: 'string' }, code: { type: 'string' } } } } } },
      responses: { 200: { description: 'JWT + user', content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthResponse' } } } } },
    },
  },
  '/api/oauth/microsoft': {
    post: {
      tags: ['OAuth'], summary: 'Login with Microsoft',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } } } },
      responses: { 200: { description: 'JWT + user' } },
    },
  },
  '/api/health': {
    get: {
      tags: ['Admin'], summary: 'Health check',
      responses: { 200: { description: 'Service status' } },
    },
  },
});

// ─── CRUD MODULES ───
Object.assign(spec.paths, crudPaths('/api/contacts', 'Contacts', 'Contact'));
Object.assign(spec.paths, crudPaths('/api/leads', 'Leads', 'Lead'));
Object.assign(spec.paths, crudPaths('/api/deals', 'Deals', 'Deal'));
Object.assign(spec.paths, crudPaths('/api/accounts', 'Accounts', 'Account'));
Object.assign(spec.paths, crudPaths('/api/products', 'Products', 'Account'));

// ─── CUSTOM ENDPOINTS ───

// Contacts
Object.assign(spec.paths, {
  '/api/contacts/{id}/timeline': { get: { tags: ['Contacts'], summary: 'Get contact timeline (activities, emails, cases, quotes)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Timeline data' } }, security: [{ bearerAuth: [] }] } },
  '/api/contacts/{id}/merge': { post: { tags: ['Contacts'], summary: 'Merge two contacts', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { mergeId: { type: 'string' }, fields: { type: 'object' } } } } } }, responses: { 200: { description: 'Merged contact' } }, security: [{ bearerAuth: [] }] } },
  '/api/contacts/{id}/duplicates': { get: { tags: ['Contacts'], summary: 'Find duplicate contacts', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Duplicate matches' } }, security: [{ bearerAuth: [] }] } },
  '/api/contacts/import-csv': { post: { tags: ['Contacts'], summary: 'Bulk import contacts from CSV data', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { records: { type: 'array', items: { $ref: '#/components/schemas/Contact' } } } } } } }, responses: { 200: { description: 'Import count' } }, security: [{ bearerAuth: [] }] } },
});

// Leads
Object.assign(spec.paths, {
  '/api/leads/{id}/convert': { post: { tags: ['Leads'], summary: 'Convert lead to contact (optionally create account/deal)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { createAccount: { type: 'boolean' }, createDeal: { type: 'boolean' }, dealName: { type: 'string' }, dealValue: { type: 'number' } } } } } }, responses: { 200: { description: 'Converted contact + account + deal' } }, security: [{ bearerAuth: [] }] } },
});

// Deals
Object.assign(spec.paths, {
  '/api/deals/stats/pipeline': { get: { tags: ['Deals'], summary: 'Pipeline statistics by stage', responses: { 200: { description: 'Pipeline stats' } }, security: [{ bearerAuth: [] }] } },
  '/api/deals/{id}/timeline': { get: { tags: ['Deals'], summary: 'Deal activity timeline', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Timeline' } }, security: [{ bearerAuth: [] }] } },
});

// ─── REPORT BUILDER ───
Object.assign(spec.paths, {
  '/api/reports': {
    get: { tags: ['Reports'], summary: 'List saved reports', parameters: [{ name: 'module', in: 'query', schema: { type: 'string' } }, { name: 'type', in: 'query', schema: { type: 'string' } }, { name: 'search', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Report list' } }, security: [{ bearerAuth: [] }] },
    post: { tags: ['Reports'], summary: 'Create a saved report definition', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Report' } } } }, responses: { 201: { description: 'Created report' } }, security: [{ bearerAuth: [] }] },
  },
  '/api/reports/metadata': { get: { tags: ['Reports'], summary: 'Get available modules, fields, operators, and chart types for report builder UI', responses: { 200: { description: 'Report metadata' } }, security: [{ bearerAuth: [] }] } },
  '/api/reports/execute': { post: { tags: ['Reports'], summary: 'Execute an ad-hoc report (no save required)', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { module: { type: 'string' }, columns: { type: 'array', items: { type: 'object' } }, filters: { type: 'array', items: { $ref: '#/components/schemas/ReportFilter' } }, groupBy: { type: 'array', items: { type: 'string' } }, aggregations: { type: 'array', items: { $ref: '#/components/schemas/ReportAggregation' } }, sortBy: { type: 'array', items: { type: 'object' } }, limit: { type: 'integer' }, reportType: { type: 'string' } }, required: ['module'] } } } }, responses: { 200: { description: 'Report results', content: { 'application/json': { schema: { $ref: '#/components/schemas/ReportResult' } } } } }, security: [{ bearerAuth: [] }] } },
  '/api/reports/preview': { post: { tags: ['Reports'], summary: 'Quick preview (limit 25 rows)', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { module: { type: 'string' } }, required: ['module'] } } } }, responses: { 200: { description: 'Preview results' } }, security: [{ bearerAuth: [] }] } },
  '/api/reports/folders/all': { get: { tags: ['Reports'], summary: 'List report folders', responses: { 200: { description: 'Folder list' } }, security: [{ bearerAuth: [] }] } },
  '/api/reports/folders': { post: { tags: ['Reports'], summary: 'Create report folder', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } }, responses: { 201: { description: 'Created' } }, security: [{ bearerAuth: [] }] } },
  '/api/reports/{id}': {
    get: { tags: ['Reports'], summary: 'Get report definition', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Report' } }, security: [{ bearerAuth: [] }] },
    put: { tags: ['Reports'], summary: 'Update report definition', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Report' } } } }, responses: { 200: { description: 'Updated' } }, security: [{ bearerAuth: [] }] },
    delete: { tags: ['Reports'], summary: 'Delete report', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Deleted' } }, security: [{ bearerAuth: [] }] },
  },
  '/api/reports/{id}/execute': { post: { tags: ['Reports'], summary: 'Execute a saved report', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Report results', content: { 'application/json': { schema: { $ref: '#/components/schemas/ReportResult' } } } } }, security: [{ bearerAuth: [] }] } },
  '/api/reports/{id}/export': { post: { tags: ['Reports'], summary: 'Export report as CSV or JSON', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { format: { type: 'string', enum: ['csv', 'json'] } } } } } }, responses: { 200: { description: 'Export data' } }, security: [{ bearerAuth: [] }] } },
  '/api/reports/{id}/clone': { post: { tags: ['Reports'], summary: 'Clone a report', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 201: { description: 'Cloned report' } }, security: [{ bearerAuth: [] }] } },
  '/api/reports/{id}/schedule': { post: { tags: ['Reports'], summary: 'Schedule a report', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { cron: { type: 'string' }, format: { type: 'string' }, recipients: { type: 'array', items: { type: 'string' } } }, required: ['cron'] } } } }, responses: { 201: { description: 'Schedule created' } }, security: [{ bearerAuth: [] }] } },
});

// ─── ENTERPRISE ENDPOINTS ───
Object.assign(spec.paths, {
  '/api/forecasts': { get: { tags: ['Forecasts'], summary: 'List forecasts', responses: { 200: { description: 'Forecast list' } }, security: [{ bearerAuth: [] }] }, post: { tags: ['Forecasts'], summary: 'Create forecast', responses: { 201: { description: 'Created' } }, security: [{ bearerAuth: [] }] } },
  '/api/forecasts/{id}/rollup': { get: { tags: ['Forecasts'], summary: 'Forecast rollup with gap analysis', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Rollup data' } }, security: [{ bearerAuth: [] }] } },
  '/api/cpq/bundles': { get: { tags: ['CPQ'], summary: 'List product bundles', responses: { 200: { description: 'Bundles' } }, security: [{ bearerAuth: [] }] } },
  '/api/cpq/bundles/configure': { post: { tags: ['CPQ'], summary: 'Configure a bundle (select options, get line items)', responses: { 200: { description: 'Configured items' } }, security: [{ bearerAuth: [] }] } },
  '/api/cpq/pricebooks': { get: { tags: ['CPQ'], summary: 'List pricebooks', responses: { 200: { description: 'Pricebooks' } }, security: [{ bearerAuth: [] }] } },
  '/api/cpq/price': { post: { tags: ['CPQ'], summary: 'Calculate price (product + pricebook + volume discount)', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { productId: { type: 'string' }, quantity: { type: 'integer' }, pricebookId: { type: 'string' } } } } } }, responses: { 200: { description: 'Calculated price' } }, security: [{ bearerAuth: [] }] } },
  '/api/approvals': { get: { tags: ['Approvals'], summary: 'List approval processes', responses: { 200: { description: 'Processes' } }, security: [{ bearerAuth: [] }] } },
  '/api/approvals/submit': { post: { tags: ['Approvals'], summary: 'Submit for approval', responses: { 200: { description: 'Submitted' } }, security: [{ bearerAuth: [] }] } },
  '/api/approvals/pending': { get: { tags: ['Approvals'], summary: 'My pending approval requests', responses: { 200: { description: 'Pending items' } }, security: [{ bearerAuth: [] }] } },
  '/api/territories': { get: { tags: ['Territories'], summary: 'List territories (tree)', responses: { 200: { description: 'Territory tree' } }, security: [{ bearerAuth: [] }] } },
  '/api/territories/{id}/stats': { get: { tags: ['Territories'], summary: 'Territory deal stats', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Stats' } }, security: [{ bearerAuth: [] }] } },
  '/api/knowledge': { get: { tags: ['Knowledge'], summary: 'List/search articles', parameters: [{ name: 'search', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Articles' } }, security: [{ bearerAuth: [] }] } },
  '/api/knowledge/categories': { get: { tags: ['Knowledge'], summary: 'List categories with article counts', responses: { 200: { description: 'Categories' } }, security: [{ bearerAuth: [] }] } },
  '/api/knowledge/{id}/vote': { post: { tags: ['Knowledge'], summary: 'Vote helpful/not helpful', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { helpful: { type: 'boolean' } } } } } }, responses: { 200: { description: 'Updated' } }, security: [{ bearerAuth: [] }] } },
  '/api/chatter': { get: { tags: ['Chatter'], summary: 'Get feed posts', responses: { 200: { description: 'Posts' } }, security: [{ bearerAuth: [] }] }, post: { tags: ['Chatter'], summary: 'Create a post', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { body: { type: 'string' }, recordModule: { type: 'string' }, recordId: { type: 'string' } } } } } }, responses: { 201: { description: 'Created' } }, security: [{ bearerAuth: [] }] } },
  '/api/chatter/{id}/like': { post: { tags: ['Chatter'], summary: 'Toggle like on post', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Toggled' } }, security: [{ bearerAuth: [] }] } },
  '/api/chatter/my-feed': { get: { tags: ['Chatter'], summary: 'My authored and mentioned posts', responses: { 200: { description: 'Feed' } }, security: [{ bearerAuth: [] }] } },
  '/api/formulas': { get: { tags: ['Formulas'], summary: 'List formula fields', responses: { 200: { description: 'Formulas' } }, security: [{ bearerAuth: [] }] } },
  '/api/formulas/test': { post: { tags: ['Formulas'], summary: 'Test formula against sample data', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { formula: { type: 'string' }, sampleData: { type: 'object' } } } } } }, responses: { 200: { description: 'Result' } }, security: [{ bearerAuth: [] }] } },
  '/api/ai/chat': { post: { tags: ['AI'], summary: 'AI assistant chat', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { message: { type: 'string' }, context: { type: 'object' } } } } } }, responses: { 200: { description: 'AI response' } }, security: [{ bearerAuth: [] }] } },
  '/api/ai/deal-coach': { post: { tags: ['AI'], summary: 'AI deal coaching', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { dealId: { type: 'string' } } } } } }, responses: { 200: { description: 'Coaching advice' } }, security: [{ bearerAuth: [] }] } },
  '/api/admin/stats': { get: { tags: ['Admin'], summary: 'System statistics', responses: { 200: { description: 'Stats' } }, security: [{ bearerAuth: [] }] } },
  '/api/admin/audit-log': { get: { tags: ['Admin'], summary: 'Audit log', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'Log entries' } }, security: [{ bearerAuth: [] }] } },
  '/api/admin/jobs': { get: { tags: ['Admin'], summary: 'List available background jobs', responses: { 200: { description: 'Job list' } }, security: [{ bearerAuth: [] }] } },
  '/api/admin/jobs/{name}': { post: { tags: ['Admin'], summary: 'Manually run a background job', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Job result' } }, security: [{ bearerAuth: [] }] } },
  '/api/users/online': { get: { tags: ['Users'], summary: 'Get online users (WebSocket)', responses: { 200: { description: 'Online user IDs' } }, security: [{ bearerAuth: [] }] } },
});

// ─── WRITE ───
const outputPath = path.join(__dirname, '..', 'src', 'openapi.json');
fs.writeFileSync(outputPath, JSON.stringify(spec, null, 2));
console.log(`OpenAPI spec written to ${outputPath}`);
console.log(`  Paths: ${Object.keys(spec.paths).length}`);
console.log(`  Schemas: ${Object.keys(spec.components.schemas).length}`);
