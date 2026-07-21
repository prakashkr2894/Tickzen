/**
 * Shared Zentrixa utilities.
 * Previously duplicated identically in zentrixa.routes.js and zentrixa-chat.service.js.
 */

export const escapeRegExp = (value = '') =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const normalize = (value = '') =>
  value.replace(/\s+/g, ' ').trim();

export const buildRegex = (value = '') =>
  new RegExp(escapeRegExp(normalize(value)), 'i');

/**
 * Creates a lightweight mock Express response object so controller functions
 * can be called directly without going through HTTP.
 */
export const createMockRes = () => {
  const state = { statusCode: 200, body: null };
  return {
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(payload) {
      state.body = payload;
      return this;
    },
    getState() {
      return state;
    },
  };
};

/**
 * Runs an Express controller function using a mock response and returns
 * the captured { statusCode, body } result.
 */
export const runController = async (controller, req) => {
  const mockRes = createMockRes();
  await controller(req, mockRes);
  return mockRes.getState();
};
