/**
 * The answer to a request for something this install cannot do: 501, with a
 * code naming the feature and a sentence saying what did not happen, as the
 * campaign send and SSO sign-in answer. Each endpoint that uses it answered as
 * if it had done its work: a flow "Completed" with nothing run, a deployment
 * "Completed" by a timer, an app "Active" with nothing installed.
 */
function unavailable(res, code, error) {
  return res.status(501).json({ code, error });
}

module.exports = { unavailable };
