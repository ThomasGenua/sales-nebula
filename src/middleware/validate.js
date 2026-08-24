/**
 * Input Validation Middleware
 * Lightweight validation without external dependencies.
 * Validates req.body, req.query, req.params against defined schemas.
 */

function validate(schema) {
  return (req, res, next) => {
    const errors = [];

    if (schema.body) {
      const bodyErrors = validateObject(req.body || {}, schema.body, 'body');
      errors.push(...bodyErrors);
    }

    if (schema.query) {
      const queryErrors = validateObject(req.query || {}, schema.query, 'query');
      errors.push(...queryErrors);
    }

    if (schema.params) {
      const paramErrors = validateObject(req.params || {}, schema.params, 'params');
      errors.push(...paramErrors);
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    next();
  };
}

function validateObject(obj, schema, location) {
  const errors = [];

  for (const [field, rules] of Object.entries(schema)) {
    const value = obj[field];

    // Required check
    if (rules.required && (value === undefined || value === null || value === '')) {
      errors.push({ field, location, message: `${field} is required` });
      continue;
    }

    // Skip further validation if not present and not required
    if (value === undefined || value === null) continue;

    // Type check
    if (rules.type) {
      if (rules.type === 'string' && typeof value !== 'string') {
        errors.push({ field, location, message: `${field} must be a string` });
      } else if (rules.type === 'number' && typeof value !== 'number' && isNaN(Number(value))) {
        errors.push({ field, location, message: `${field} must be a number` });
      } else if (rules.type === 'boolean' && typeof value !== 'boolean') {
        errors.push({ field, location, message: `${field} must be a boolean` });
      } else if (rules.type === 'array' && !Array.isArray(value)) {
        errors.push({ field, location, message: `${field} must be an array` });
      } else if (rules.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
        errors.push({ field, location, message: `${field} must be an object` });
      } else if (rules.type === 'email' && typeof value === 'string') {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          errors.push({ field, location, message: `${field} must be a valid email` });
        }
      } else if (rules.type === 'uuid' && typeof value === 'string') {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
          errors.push({ field, location, message: `${field} must be a valid UUID` });
        }
      } else if (rules.type === 'date' && typeof value === 'string') {
        if (isNaN(Date.parse(value))) {
          errors.push({ field, location, message: `${field} must be a valid date` });
        }
      }
    }

    // String constraints
    if (typeof value === 'string') {
      if (rules.minLength && value.length < rules.minLength) {
        errors.push({ field, location, message: `${field} must be at least ${rules.minLength} characters` });
      }
      if (rules.maxLength && value.length > rules.maxLength) {
        errors.push({ field, location, message: `${field} must be at most ${rules.maxLength} characters` });
      }
      if (rules.pattern && !rules.pattern.test(value)) {
        errors.push({ field, location, message: `${field} format is invalid` });
      }
    }

    // Number constraints
    if (typeof value === 'number' || (rules.type === 'number' && !isNaN(Number(value)))) {
      const num = Number(value);
      if (rules.min !== undefined && num < rules.min) {
        errors.push({ field, location, message: `${field} must be at least ${rules.min}` });
      }
      if (rules.max !== undefined && num > rules.max) {
        errors.push({ field, location, message: `${field} must be at most ${rules.max}` });
      }
    }

    // Enum check
    if (rules.enum && !rules.enum.includes(value)) {
      errors.push({ field, location, message: `${field} must be one of: ${rules.enum.join(', ')}` });
    }

    // Array constraints
    if (Array.isArray(value)) {
      if (rules.minItems && value.length < rules.minItems) {
        errors.push({ field, location, message: `${field} must have at least ${rules.minItems} items` });
      }
      if (rules.maxItems && value.length > rules.maxItems) {
        errors.push({ field, location, message: `${field} must have at most ${rules.maxItems} items` });
      }
    }
  }

  return errors;
}

// ─── COMMON VALIDATION SCHEMAS ───

const schemas = {
  // Auth
  register: {
    body: {
      email: { required: true, type: 'email' },
      password: { required: true, type: 'string', minLength: 8, maxLength: 128 },
      firstName: { required: true, type: 'string', minLength: 1, maxLength: 100 },
      lastName: { required: true, type: 'string', minLength: 1, maxLength: 100 },
    },
  },
  login: {
    body: {
      email: { required: true, type: 'email' },
      password: { required: true, type: 'string', minLength: 1 },
    },
  },

  // Contacts
  createContact: {
    body: {
      firstName: { required: true, type: 'string', minLength: 1, maxLength: 100 },
      lastName: { required: true, type: 'string', minLength: 1, maxLength: 100 },
      email: { type: 'email' },
    },
  },

  // Leads
  createLead: {
    body: {
      firstName: { required: true, type: 'string', minLength: 1, maxLength: 100 },
      lastName: { required: true, type: 'string', minLength: 1, maxLength: 100 },
    },
  },

  // Deals
  createDeal: {
    body: {
      name: { required: true, type: 'string', minLength: 1, maxLength: 200 },
      amount: { type: 'number', min: 0 },
      stage: { type: 'string' },
    },
  },

  // Cases
  createCase: {
    body: {
      subject: { required: true, type: 'string', minLength: 1, maxLength: 500 },
      priority: { enum: ['Low', 'Medium', 'High', 'Critical'] },
    },
  },

  // Webhooks
  createWebhook: {
    body: {
      name: { required: true, type: 'string', minLength: 1, maxLength: 200 },
      url: { required: true, type: 'string', minLength: 1 },
      events: { required: true, type: 'array', minItems: 1 },
    },
  },

  // Reports
  createReport: {
    body: {
      name: { required: true, type: 'string', minLength: 1, maxLength: 200 },
      module: { required: true, type: 'string' },
    },
  },

  // Pagination query
  pagination: {
    query: {
      page: { type: 'number', min: 1 },
      limit: { type: 'number', min: 1, max: 200 },
    },
  },

  // UUID param
  idParam: {
    params: {
      id: { required: true, type: 'uuid' },
    },
  },
};

module.exports = { validate, schemas, validateObject };
