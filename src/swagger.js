/**
 * Swagger setup - mounts Swagger UI at /api/docs
 * Call setupSwagger(app) from index.js to enable.
 */

function setupSwagger(app) {
  let swaggerUi, spec;
  try {
    swaggerUi = require('swagger-ui-express');
    spec = require('./openapi.json');
  } catch (e) {
    console.log('  Swagger: swagger-ui-express not installed or spec missing, skipping');
    return;
  }

  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'Sales Nebula API Docs',
    swaggerOptions: {
      persistAuthorization: true,
      filter: true,
      displayRequestDuration: true,
    },
  }));

  // Serve raw spec
  app.get('/api/docs.json', (req, res) => res.json(spec));

  console.log('  Swagger: /api/docs');
}

module.exports = { setupSwagger };
