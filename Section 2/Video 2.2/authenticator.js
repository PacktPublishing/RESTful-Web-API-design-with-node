var OAuth = require('oauth').OAuth;
var config = require('./config');

// Create the oauth object for accessing Twitter
var oauth = new OAuth(
	config.request_token_url,
	config.access_token_url,
	config.consumer_key,
	config.consumer_secret,
	config.oauth_version,
	config.oauth_callback,
	config.oauth_signature
);

module.exports = {
	redirectToTwitterLoginPage: function(req, res) {
		// Ask Twitter for a request token
		oauth.getOAuthRequestToken(function(error, oauth_token, oauth_token_secret, results) {
			if (error) {
				console.log(error);
				res.send("Authentication failed!");
			} else {
				// Use the request token to take the client to Twitter's authentication page
				res.cookie('oauth_token', oauth_token, { httpOnly: true });
				res.cookie('oauth_token_secret', oauth_token_secret, { httpOnly: true });
				res.redirect(config.authorize_url + '?oauth_token='+oauth_token);
			}
		});
	},
	authenticate: function(req, res, cb) {
		// Check if the request token and temporary credential are there
		if (!(req.cookies.oauth_token && req.cookies.oauth_token_secret && req.query.oauth_verifier)) {
			return cb("Request does not have all required keys");
		}

		// Clear the request token cookies
		res.clearCookie('oauth_token');
		res.clearCookie('oauth_token_secret');

		// Tell router that authentication was successful
		cb();
	}
};