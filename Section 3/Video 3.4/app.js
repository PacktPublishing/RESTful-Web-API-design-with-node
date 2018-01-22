module.exports = function() {
	var url = require('url');
	var express = require('express');
	var bodyParser = require('body-parser');
	var querystring = require('querystring');
	var async = require('async');
	var MongoClient = require('mongodb').MongoClient;
	var ObjectID = require('mongodb').ObjectID;
	var authenticator = require('./authenticator');
	var config = require('./config');
	var app = express();
	var database;

	// Connect to MongoDB
	MongoClient.connect('mongodb://localhost:27017/twitter_notes', function(err, db) {
		if (err) {
			return console.log("Error: " + err);
		}

		db.open(function(err, db) {
			database = db;
			console.log("Connected to database.");
		});
	});

	// Set the view engine to ejs
	app.set('view engine', 'ejs');

	// Add cookie parsing functionality to our Express app
	app.use(require('cookie-parser')());

	// Parse JSON body and store result in req.body
	app.use(bodyParser.json());

	// Take user to Twitter's login page
	app.get('/auth/twitter', authenticator.redirectToTwitterLoginPage);

	// This is the callback url that the user is redirected to after signing in
	app.get(url.parse(config.oauth_callback).path, function(req, res) {
		authenticator.authenticate(req, res, function(err) {
			if (err) {
				res.redirect('/login');
			} else {
				res.redirect('/');
			}
		});
	});

	// Main page handler
	app.get('/', function(req, res) {
		if (!req.cookies.access_token || !req.cookies.access_token_secret || !req.cookies.twitter_id) {
			return res.redirect('/login');
		}

		// If the app couldn't connect to the database, get data from Twitter's API
		if (!database) {
			return renderMainPageFromTwitter(req, res);
		}

		var cursor = database.collection('friends').find({
			for_user: req.cookies.twitter_id
		});

		cursor.toArray(function(err, friends) {
			if (err) {
				return res.status(500).send(err);
			}

			if (friends.length > 0) {
				// Sort the friends alphabetically by name
				friends.sort(function(a, b) {
					return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
				});

				// Render the main application
				res.render('index', {
					friends: friends
				});
			} else {
				renderMainPageFromTwitter(req, res);
			}
		});
	});

	function renderMainPageFromTwitter(req, res) {
		async.waterfall([
			// Get friends' IDs
			function(cb) {
				var cursor = -1;
				var ids = [];

				// Get IDs by traversing the cursored collection
				async.whilst(function() {
					return cursor != 0;
				}, function(cb) {
					authenticator.get('https://api.twitter.com/1.1/friends/ids.json?' + querystring.stringify({user_id: req.cookies.twitter_id, cursor: cursor}),
						req.cookies.access_token, req.cookies.access_token_secret,
						function(error, data) {
							if (error) {
								return res.status(400).send(error);
							}

							data = JSON.parse(data);
							cursor = data.next_cursor_str;
							ids = ids.concat(data.ids);

							cb();
						});
				}, function(error) {
					if (error) {
						return res.status(500).send(error);
					}

					cb(null, ids);
				});
			},
			// Get friends' data
			function(ids, cb) {
				// Returns up to 100 ids starting from 100*i
				var getHundredthIds = function(i) {
					return ids.slice(100*i, Math.min(ids.length, 100*(i+1)));
				}
				var requestsNeeded = Math.ceil(ids.length/100);

				async.times(requestsNeeded, function(n, next) {
					var url = 'https://api.twitter.com/1.1/users/lookup.json?' + querystring.stringify({user_id: getHundredthIds(n).join(',')});

					authenticator.get(url,
						req.cookies.access_token, req.cookies.access_token_secret,
						function(error, data) {
							if (error) {
								return res.status(400).send(error);
							}

							var friends = JSON.parse(data);
							next(null, friends);
					});
				},
				function (err, friends) {
					// Flatten friends array
					friends = friends.reduce(function(previousValue, currentValue, currentIndex, array) {
					  return previousValue.concat(currentValue);
					}, []);

					// Sort the friends alphabetically by name
					friends.sort(function(a, b) {
						return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
					});

					// Transform friends into the format that our application needs
					friends = friends.map(function(friend) {
						return {
							twitter_id: friend.id_str,
							for_user: req.cookies.twitter_id,
							name: friend.name,
							location: friend.location,
							profile_image_url: friend.profile_image_url
						};
					});

					// Render the main application
					res.render('index', {
						friends: friends
					});

					// In the background, save the friends to MongoDB
					if (database) {
						database.collection('friends').insert(friends, function(err, result) {
							if (err) {
								console.log("Cannot insert friends to database.");
							}
						});
					}
				});
			}
		]);
	}

	// Show the login page
	app.get('/login', function(req, res) {
		res.render('login');
	});

	function ensureLoggedIn(req, res, next) {
		if (!req.cookies.access_token || !req.cookies.access_token_secret || !req.cookies.twitter_id) {
			return res.sendStatus(401);
		}

		next();
	}

	// Get notes for a friend
	app.get('/friends/:uid/notes', ensureLoggedIn, function(req, res, next) {
		var cursor = database.collection('notes').find({
			owner_id: req.cookies.twitter_id,
			friend_id: req.params.uid
		});

		cursor.toArray(function(err, notes) {
			if (err) {
				return res.status(500).send(err);
			}

			res.send(notes.map(function(note) {
				return {
					_id: note._id,
					content: note.content
				};
			}));
		});
	});

	// Add a new note to a friend
	app.post('/friends/:uid/notes', ensureLoggedIn, function(req, res) {
		if (!req.get('Content-Type')) {
			return res.status(400).send("Bad Request: Set Content-Type to application/json");
		} else if (!req.body.content) {
			return res.status(400).send("Bad Request: content is required");
		}
		
		database.collection('notes').insert({
			owner_id: req.cookies.twitter_id,
			friend_id: req.params.uid,
			content: req.body.content
		},
		function(err, result) {
			if (err) {
				return res.status(500).error(err);
			}

			res.send({
				_id: result.ops[0]._id,
				content: result.ops[0].content
			});
		});
	});

	// Update a note
	app.put('/friends/:uid/notes/:noteid', ensureLoggedIn, function(req, res) {
		var noteId = req.params.noteid;

		database.collection('notes').updateOne({
			_id: new ObjectID(noteId),
			owner_id: req.cookies.twitter_id // Used to protect other users' data
		},
		{
			$set: { content: req.body.content }
		},
		function(err, result) {
			if (err) {
				return res.status(500).send(err);
			}

			database.collection('notes').findOne({
				_id: new ObjectID(noteId)
			}, function(err, note) {
				if (err) {
					return res.status(500).send(err);
				}

				res.send({
					_id: note._id,
					content: note.content
				});
			});
		});
	});

	// Delete a note
	app.delete('/friends/:uid/notes/:noteid', ensureLoggedIn, function(req, res) {
		database.collection('notes').deleteOne({
			_id: new ObjectID(req.params.noteid),
			owner_id: req.cookies.twitter_id // Used to protect other users' data
		}, function(err) {
			if (err) {
				return res.status(500).send(err);
			}

			res.sendStatus(200);
		});
	});

	// Serve static files in public directory
	app.use(express.static(__dirname + '/public'));

	// Start listening for requests
	app.listen(config.port, function() {
		console.log("Listening on port " + config.port);
	});
}
