const ipaddr = require('ipaddr.js');
const forBigTable = require('./forBigTable')
const compareVersions = require('compare-versions');
const getTorrent = require('./gettorrent')
const _ = require('lodash')

module.exports = async ({
	sphinx,
	send,
	recive,
	p2p,
	config,
	baseRowData,
	torrentClient,
	spider,
	upnp,
	crypto,
	insertTorrentToDB,
	removeTorrentFromDB,
	updateTorrentToDB,
	checkTorrent,
	p2pStore,
	feed
}) => {
	let torrentClientHashMap = {}

	let topCache = {};
	setInterval(() => {
		topCache = {};
	}, 24 * 60 * 60 * 1000);


	const mergeTorrentsWithDownloads = (torrents, copy) => {
		if(!torrents)
			return torrents

		if(copy)
			torrents = _.cloneDeep(torrents)

		const mergeTorrent = (torrent) => {
			const id = torrentClientHashMap[torrent.hash]
			if(id)
			{
				const download = torrentClient.get(id)
				torrent.download = {
					received: download.received,
					downloaded: download.downloaded,
					progress: download.progress,
					downloadSpeed: download.downloadSpeed,
                    
					removeOnDone: download.removeOnDone,
					paused: torrent.paused || torrent._paused
				}
			}
		}

		if(Array.isArray(torrents))
		{
			for(const torrent of torrents)
			{
				mergeTorrent(torrent)
			}
		}
		else
		{
			mergeTorrent(torrents)
		}

		return torrents
	}

	const mergeTorrentsWithDownloadsFn = (Fn, copy) => (...args) => { 
		const callback = args[args.length - 1]
		const rest = args.slice(0, -1)
		Fn(...rest, (data) => callback(mergeTorrentsWithDownloads(data, copy))) 
	}

	recive('recentTorrents', function(callback)
	{
		if(typeof callback != 'function')
			return;

		sphinx.query('SELECT * FROM `torrents` ORDER BY added DESC LIMIT 0,10', function (error, rows, fields) {
			if(!rows) {
				callback(undefined)
				return;
			}

			let torrents = [];
			rows.forEach((row) => {
				torrents.push(baseRowData(row));
			});

			callback(torrents)
		});
	});

	recive('statistic', function(callback)
	{
		if(typeof callback != 'function')
			return;

		sphinx.query('SELECT count(*) AS torrents, sum(size) AS sz FROM `torrents`', function (error, rows, fields) {
			if(!rows) {
				console.error(error)
				callback(undefined)
				return;
			}

			let result = {torrents: rows[0].torrents || 0, size: rows[0].sz || 0}

			sphinx.query('SELECT count(*) AS files FROM `files`', function (error, rows, fields) {
				if(!rows) {
					console.error(error)
					callback(undefined)
					return;
				}

				result.files = rows[0].files || 0

				callback(result)
			})
		});
	});

	const onTorrent = (hash, options, callback) => {
		if(hash.length != 40)
			return;

		if(typeof callback != 'function')
			return;

		// remote request
		if(options.peer)
		{
			console.log('remote torrent request to peer')
			const peer = p2p.find(options.peer)
			if(!peer)
			{
				console.log('dont found requested peer in peers')
				callback(undefined)
				return;
			}
			delete options.peer;
			peer.emit('torrent', {hash, options}, (data, nil, address) => {
				console.log('remote torrent result', hash)
				callback(data)

				if(compareVersions(address.version, '0.19.0') < 0)
				{
					console.log('replication selected torrent now works only with 0.19.0 version, ignore this torrent')
					return
				}

				if(data)
					insertTorrentToDB(data, true) // copy torrent to our db
			})
			return;
		}

		sphinx.query('SELECT * FROM `torrents` WHERE `hash` = ?', hash, async function (error, rows, fields) {
			if(!rows || rows.length == 0) {
				callback(undefined)
				return;
			}
			let torrent = rows[0];

			if(options.files)
			{
				torrent.filesList = await sphinx.query('SELECT * FROM `files` WHERE `hash` = ? LIMIT 50000', hash);
				callback(baseRowData(torrent))
			}
			else
			{
				callback(baseRowData(torrent))
			}

			// get votes
			const {good, bad, selfVote} = await getVotes(hash)
			send('votes', {
				hash, good, bad, selfVote
			});
			if(torrent.good != good || torrent.bad != bad)
			{
				console.log('finded new rating on', torrent.name, 'update votes to it')
				torrent.good = good
				torrent.bad = bad
				updateTorrentToDB(torrent)
			}
		});
	}

	recive('torrent', mergeTorrentsWithDownloadsFn(onTorrent));
	p2p.on('torrent', ({hash, options} = {}, callback) => {
		if(!hash)
			return;

		onTorrent(hash, options, (data) => callback(data))
	})

	if(config.p2pReplicationServer)
	{
		console.log('p2p replication server enabled')

		p2p.on('randomTorrents', (nil, callback) => {
			if(typeof callback != 'function')
				return;
    
			sphinx.query('SELECT * FROM `torrents` ORDER BY rand() limit 5', (error, torrents) => {
				if(!torrents || torrents.length == 0) {
					callback(undefined)
					return;
				}
    
				let hashes = {}
				for(const torrent of torrents)
				{
					delete torrent.id
					hashes[torrent.hash] = torrent
				}
    
				const inSql = Object.keys(hashes).map(hash => sphinx.escape(hash)).join(',');
				sphinx.query(`SELECT * FROM files WHERE hash IN(${inSql}) limit 50000`, (error, files) => {
					if(!files)
					{
						files = []
					}
    
					files.forEach((file) => {
						if(!hashes[file.hash].filesList)
							hashes[file.hash].filesList = []
						hashes[file.hash].filesList.push(file)
					})
					callback(Object.values(hashes))
				})
			})
		});

		if(config.p2pReplication)
		{
			const getReplicationTorrents = (nextTimeout = 5000) => {
				let gotTorrents = 0
				p2p.emit('randomTorrents', null, (torrents, nil, address) => {
					if(!torrents || torrents.length == 0)
						return

					if(compareVersions(address.version, '0.19.0') < 0)
					{
						console.log('replication now works only with 0.19.0 version, ignore this torrent')
						return
					}

					gotTorrents += torrents.length

					torrents.forEach((torrent) => {
						console.log('replicate remote torrent', torrent && torrent.name)
						insertTorrentToDB(torrent)
					})
				})

				setTimeout(() => getReplicationTorrents(gotTorrents > 8 ? gotTorrents * 600 : 10000), nextTimeout)
			}
			// start
			console.log('replication client is enabled')
			getReplicationTorrents()
		}
	}

	const searchTorrentCall = function(text, navigation, callback)
	{
		if(typeof callback != 'function')
			return;

		if(!text || text.length <= 2) {
			callback(undefined);
			return;
		}

		const safeSearch = !!navigation.safeSearch;

		const index = navigation.index || 0;
		const limit = navigation.limit || 10;
		let args = [text, index, limit];
		const orderBy = navigation.orderBy;
		let order = '';
		let where = '';
		if(orderBy && orderBy.length > 0)
		{
			const orderDesc = navigation.orderDesc ? 'DESC' : 'ASC';
			args.splice(1, 0, orderBy);
			order = 'ORDER BY ?? ' + orderDesc;
		}
		if(safeSearch)
		{
			where += " and contentCategory != 'xxx' ";
		}
		if(navigation.type && navigation.type.length > 0)
		{
			where += ' and contentType = ' + sphinx.escape(navigation.type) + ' ';
		}
		if(navigation.size)
		{
			if(navigation.size.max > 0)
				where += ' and size < ' + sphinx.escape(navigation.size.max) + ' ';
			if(navigation.size.min > 0)
				where += ' and size > ' + sphinx.escape(navigation.size.min) + ' ';
		}
		if(navigation.files)
		{
			if(navigation.files.max > 0)
				where += ' and files < ' + sphinx.escape(navigation.files.max) + ' ';
			if(navigation.files.min > 0)
				where += ' and files > ' + sphinx.escape(navigation.files.min) + ' ';
		}

		let searchList = [];
		//args.splice(orderBy && orderBy.length > 0 ? 1 : 0, 1);
		//sphinx.query('SELECT * FROM `torrents` WHERE `name` like \'%' + text + '%\' ' + where + ' ' + order + ' LIMIT ?,?', args, function (error, rows, fields) {
		sphinx.query('SELECT * FROM `torrents` WHERE MATCH(?) ' + where + ' ' + order + ' LIMIT ?,?', args, function (error, rows, fields) {
			if(!rows) {
				console.log(error)
				callback(undefined)
				return;
			}
			rows.forEach((row) => {
				searchList.push(baseRowData(row));
			});
			callback(searchList);
		});
	}

	recive('searchTorrent', mergeTorrentsWithDownloadsFn((text, navigation, callback) => {
		searchTorrentCall(text, navigation, callback)
		p2p.emit('searchTorrent', {text, navigation}, (remote, socketObject) => {
			console.log('remote search results', remote && remote.length)
			if(remote && remote.length > 0)
			{
				const { _socket: socket } = socketObject
				const peer = { address: socket.remoteAddress, port: socket.remotePort }
				remote = remote.map(torrent => Object.assign(torrent, {peer}))
			}
			send('remoteSearchTorrent', mergeTorrentsWithDownloads(remote))
		})
	}));

	p2p.on('searchTorrent', ({text, navigation} = {}, callback) => {
		if(!text)
			return;

		searchTorrentCall(text, navigation, (data) => callback(data))
	})

	const searchFilesCall = function(text, navigation, callback)
	{
		if(typeof callback != 'function')
			return;

		if(!text || text.length <= 2) {
			callback(undefined);
			return;
		}

		const safeSearch = !!navigation.safeSearch;

		const index = navigation.index || 0;
		const limit = navigation.limit || 10;
		let args = [text, index, limit];
		const orderBy = navigation.orderBy;
		let order = '';
		let where = '';

		/*
        if(orderBy && orderBy.length > 0)
        {
            const orderDesc = navigation.orderDesc ? 'DESC' : 'ASC';
            args.splice(1, 0, orderBy);
            order = 'ORDER BY ?? ' + orderDesc;
        }
        */
		/*
        if(safeSearch)
        {
            where += " and contentCategory != 'xxx' ";
        }
        if(navigation.type && navigation.type.length > 0)
        {
            where += ' and contentType = ' + sphinx.escape(navigation.type) + ' ';
        }
        if(navigation.size)
        {
            if(navigation.size.max > 0)
                where += ' and torrentSize < ' + sphinx.escape(navigation.size.max) + ' ';
            if(navigation.size.min > 0)
                where += ' and torrentSize > ' + sphinx.escape(navigation.size.min) + ' ';
        }
        if(navigation.files)
        {
            if(navigation.files.max > 0)
                where += ' and files < ' + sphinx.escape(navigation.files.max) + ' ';
            if(navigation.files.min > 0)
                where += ' and files > ' + sphinx.escape(navigation.files.min) + ' ';
        }
        */

		let search = {};
		//args.splice(orderBy && orderBy.length > 0 ? 1 : 0, 1);
		//sphinx.query('SELECT * FROM `files` inner join torrents on(torrents.hash = files.hash) WHERE files.path like \'%' + text + '%\' ' + where + ' ' + order + ' LIMIT ?,?', args, function (error, rows, fields) {
		sphinx.query('SELECT * FROM `files` WHERE MATCH(?) ' + where + ' ' + order + ' LIMIT ?,?', args, function (error, files, fields) {
			if(!files) {
				console.log(error)
				callback(undefined)
				return;
			}
			if(files.length === 0)
			{
				callback(undefined)
				return;
			}
			for(const file of files)
			{
				if(!search[file.hash])
				{
					search[file.hash] = { path: [] }
				}
				search[file.hash].path.push(file.path)
			}
			const inSql = Object.keys(search).map(hash => sphinx.escape(hash)).join(',');
			sphinx.query(`SELECT * FROM torrents WHERE hash IN(${inSql})`, (err, torrents) => {
				if(!torrents) {
					console.log(err)
					return;
				}

				for(const torrent of torrents)
				{
					search[torrent.hash] = Object.assign(baseRowData(torrent), search[torrent.hash])
                    
					// temporary ignore adult content in search (workaroud)
					if(safeSearch && search[torrent.hash].contentCategory == 'xxx')
						delete search[torrent.hash]
				}

				let searchResult = Object.values(search)

				if(orderBy && orderBy.length > 0 && searchResult.length > 0)
				{
					searchResult = _.orderBy(searchResult, [orderBy], [navigation.orderDesc ? 'desc' : 'asc'])
				}

				callback(searchResult);
			})
		});
	}

	recive('searchFiles', mergeTorrentsWithDownloadsFn((text, navigation, callback) => {
		searchFilesCall(text, navigation, callback)
		p2p.emit('searchFiles', {text, navigation}, (remote, socketObject) => {
			console.log('remote search files results', remote && remote.length)
			if(remote && remote.length > 0)
			{
				const { _socket: socket } = socketObject
				const peer = { address: socket.remoteAddress, port: socket.remotePort }
				remote = remote.map(torrent => Object.assign(torrent, {peer}))
			}
			send('remoteSearchFiles', mergeTorrentsWithDownloads(remote))
		})
	}));

	p2p.on('searchFiles', ({text, navigation} = {}, callback) => {
		if(!text)
			return;

		searchFilesCall(text, navigation, (data) => callback(data))
	})

	recive('checkTrackers', function(hash)
	{
		if(hash.length != 40)
			return;

		updateTorrentTrackers(hash);
	});

	const topTorrentsCall = (type, navigation = {}, callback) => {
		let where = '';

		const index = parseInt(navigation.index) || 0;
		const limit = parseInt(navigation.limit) || 20;
		const time = navigation.time

		if(type && type.length > 0)
		{
			where += ' and contentType = ' + sphinx.escape(type) + ' ';
		}

		if(time)
		{
			if(time == 'hours')
			{
				where += ' and `added` > ' + (Math.floor(Date.now() / 1000) - (60 * 60 * 24))
			}
			else if(time == 'week')
			{
				where += ' and `added` > ' + (Math.floor(Date.now() / 1000) - (60 * 60 * 24 * 7))
			}
			else if(time == 'month')
			{
				where += ' and `added` > ' + (Math.floor(Date.now() / 1000) - (60 * 60 * 24 * 30))
			}
		}
        
		const query = `SELECT * FROM torrents WHERE seeders > 0 and contentCategory != 'xxx' ${where} ORDER BY seeders DESC LIMIT ${index},${limit}`;
		if(topCache[query])
		{
			callback(topCache[query]);
			return;
		}
		sphinx.query(query, function (error, rows) {
			if(!rows || rows.length == 0) {
				callback(undefined)
				return;
			}
            
			rows = rows.map((row) => baseRowData(row));
			topCache[query] = rows;
			callback(rows);
		});
	}

	recive('topTorrents', mergeTorrentsWithDownloadsFn((type, navigation, callback) =>
	{
		topTorrentsCall(type, navigation, callback)
		p2p.emit('topTorrents', {type, navigation}, (remote, socketObject) => {
			console.log('remote top results', remote && remote.length)
			if(remote && remote.length > 0)
			{
				const { _socket: socket } = socketObject
				const peer = { address: socket.remoteAddress, port: socket.remotePort }
				remote = remote.map(torrent => Object.assign(torrent, {peer}))
			}
			send('remoteTopTorrents', {torrents: mergeTorrentsWithDownloads(remote), type, time: navigation && navigation.time})
		})
	}));

	p2p.on('topTorrents', ({type, navigation} = {}, callback) => {
		topTorrentsCall(type, navigation, (data) => callback(data))
	})

	recive('peers', (callback) =>
	{
		if(typeof callback != 'function')
			return;

		callback({
			size: p2p.size,
			torrents: p2p.peersList().reduce((prev, peer) => prev + (peer.info ? peer.info.torrents || 0 : 0), 0)
		})
	});

	recive('p2pStatus', (callback) =>
	{
		if(typeof callback != 'function')
			return;

		callback(p2p.p2pStatus)
	});

	recive('config', (callback) =>
	{
		if(typeof callback != 'function')
			return;

		callback(config)
	});

	recive('setConfig', (options, callback) =>
	{
		if(typeof options !== 'object')
			return;

		if(typeof options.indexer !== 'undefined')
		{
			const upSpider = () => {
				if(options.indexer)
					spider.listen(config.spiderPort)
				else
					spider.close()
			}

			if(options.spiderPort !== config.spiderPort)
				spider.close(upSpider)
			else
				upSpider()
		}

		if(upnp)
			upnp.ratsUnmap()

		for(const option in options)
		{
			if(option in config)
				config[option] = options[option]
		}

		if(upnp)
			upnp.ratsMap()

		if(config.p2p)
		{
			spider.announceHashes = [crypto.createHash('sha1').update('degrats-v1').digest()]
		}
		else
		{
			spider.announceHashes = []
		}
        
		if(typeof callback === 'function')
			callback(true)
	});

	torrentClient._add = (torrentObject, savePath, callback) =>
	{
		const magnet = `magnet:?xt=urn:btih:${torrentObject.hash}`
		console.log('download', magnet)
		if(torrentClient.get(magnet)) {
			console.log('aready added')
			if(callback)
				callback(false)
			return
		}

		const torrent = torrentClient.add(magnet, {path: savePath || config.client.downloadPath})
		torrentClientHashMap[torrent.infoHash] = magnet
		torrent.torrentObject = torrentObject

		const progress = (bytes) => {
			send('downloadProgress', torrent.infoHash, {
				received: bytes,
				downloaded: torrent.downloaded,
				downloadSpeed: torrent.downloadSpeed,
				progress: torrent.progress,
				timeRemaining: torrent.timeRemaining
			})
		}

		torrent.on('ready', () => {
			console.log('start downloading', torrent.infoHash, 'to', torrent.path)
			send('downloading', torrent.infoHash)
			progress(0) // immediately display progress
			if(torrent._paused)
			{
				delete torrent._paused
				torrent._pause()
			}
		})

		torrent.on('done', () => { 
			console.log('download done', torrent.infoHash)
			progress(0) // update progress
			// remove torrent if marked
			if(torrent.removeOnDone)
			{
				torrentClient.remove(magnet, (err) => {
					if(err)
					{
						console.log('download removing error', err)
						return
					}
        
					delete torrentClientHashMap[torrent.infoHash]
					send('downloadDone', torrent.infoHash)
				})
			}
			else
			{
				send('downloadDone', torrent.infoHash)
			}
		})

		let now = Date.now()
		torrent.on('download', (bytes) => {
			if(Date.now() - now < 100)
				return
			now = Date.now()

			progress(bytes)
		})

		//custom api pause
		torrent._pause = () => {
			console.log('pause torrent downloading', torrent.infoHash)
			torrent.pause()
			torrent.wires = [];
			setTimeout(() => {
				if(torrent.paused)
					torrent.wires = [];
			}, 100) // make sure no more wires appears
		}

		torrent._restoreWires = () => {
			for(const p in torrent._peers){
				const wire = torrent._peers[p].wire
				if(wire)
					torrent.wires.push(wire);
			}
		}

		torrent._resume = () => {
			console.log('resume torrent downloading', torrent.infoHash)
			torrent._restoreWires()
			torrent.resume()
		}

		// fix wires after pause
		const _destroy = torrent._destroy
		torrent._destroy = (...args) => {
			// fix pause wires closing
			if(torrent.paused)
			{
				torrent._restoreWires()
			}
			return _destroy.call(torrent, ...args)
		}


		if(callback)
			callback(true)

		return torrent
	}

	recive('download', torrentClient._add);

	recive('downloadUpdate', (hash, options) =>
	{
		const id = torrentClientHashMap[hash]
		if(!id)
		{
			console.log('cant find torrent for removing', hash)
			return
		}
        
		const torrent = torrentClient.get(id)
		if(!torrent) {
			console.log('no torrent for update founded')
			return
		}

		if(options.removeOnDone)
		{
			torrent.removeOnDone = options.removeOnDone == 'switch' ? !torrent.removeOnDone : options.removeOnDone
		}

		if(typeof options.pause !== 'undefined')
		{
			const pause = options.pause == 'switch' ? !torrent.paused : options.pause
			if(pause)
				torrent._pause()
			else
				torrent._resume()
		}

		send('downloadUpdate', torrent.infoHash, {
			removeOnDone: torrent.removeOnDone,
			paused: torrent.paused || torrent._paused
		})
	})

	recive('downloadCancel', (hash, callback) =>
	{
		const id = torrentClientHashMap[hash]
		if(!id)
		{
			console.log('cant find torrent for removing', hash)
			if(callback)
				callback(false)
			return
		}

		torrentClient.remove(id, (err) => {
			if(err)
			{
				console.log('download removing error', err)
				if(callback)
					callback(false)
				return
			}

			delete torrentClientHashMap[hash]
			send('downloadDone', hash, true)

			if(callback)
				callback(true)
		})
	})

	recive('downloads', (callback) =>
	{
		callback(torrentClient.torrents.map(torrent => ({
			torrentObject: torrent.torrentObject,
			received: torrent.received,
			downloaded: torrent.downloaded,
			progress: torrent.progress,
			downloadSpeed: torrent.downloadSpeed,
            
			removeOnDone: torrent.removeOnDone,
			paused: torrent.paused || torrent._paused
		})))
	})

	recive('removeTorrents', (checkOnly = true, callback) =>
	{
		console.log('checktorrents call')

		const toRemove = []

		const done = () => {
			console.log('torrents to remove founded', toRemove.length)
			if(checkOnly)
			{
				callback(toRemove.length)
				return
			}

			toRemove.forEach(torrent => removeTorrentFromDB(torrent))
			callback(toRemove.length)
			console.log('removed torrents by filter:', toRemove.length)
		}

		forBigTable(sphinx, 'torrents', (torrent) => {
			if(!checkTorrent(torrent))
				toRemove.push(torrent)
		}, done)
	})

	const getVotes = async (hash) => {
		const votes = await p2pStore.find(`vote:${hash}`)
		let good = 0
		let bad = 0
		let selfVote = false
		if(votes)
		{
			votes.forEach(({vote, _peerId}) => {
				if(_peerId === p2p.peerId)
					selfVote = true

				if(vote == 'bad')
					bad++
				else
					good++
			})
		}

		return {good, bad, selfVote}
	}

	recive('vote', async (hash, isGood, callback) =>
	{
		if(hash.length != 40)
			return;

		if(typeof callback != 'function')
			return;

		isGood = !!isGood;

		const action = isGood ? 'good' : 'bad';
		let {good, bad, selfVote} = await getVotes(hash)

		if(!selfVote)
		{
			setTimeout(async () => p2pStore.store({
				type: 'vote',
				torrentHash: hash,
				vote: action,
				_index: `vote:${hash}`,
				_temp: {
					torrent: await getTorrent(sphinx, hash)
				}
			}), 0)
			good += isGood ? 1 : 0
			bad += !isGood ? 1 : 0
		}

		send('votes', {
			hash, good, bad
		});
		callback(true)

	});

	// store torrent to feed
	await feed.load()
	p2pStore.on('store', async ({data: record, temp, myself}) => {
		if(record.type !== 'vote')
			return

		if(!temp || !temp.torrent)
			return
    
		const { torrent } = temp
        
		if(torrent.hash !== record.torrentHash)
			return

		if(!myself)
		{
			console.log('replicate torrent from store record', torrent.hash)
			await insertTorrentToDB(torrent)
		}

		let {good, bad} = await getVotes(torrent.hash)
		torrent.good = good
		torrent.bad = bad
		if(torrent.good > 0 || torrent.bad > 0)
			updateTorrentToDB(torrent)

		// update feed
		if(record.vote !== 'good')
			return
        
		feed.add(torrent)
		send('feedUpdate', {
			feed: feed.feed
		});
	})

	const feedCall = (callback) =>
	{
		callback(feed.feed)
	}
	recive('feed', mergeTorrentsWithDownloadsFn(feedCall, true)); // don't overwrite feed value

	p2p.on('feed', ({}, callback) => {
		feedCall((data) => callback(data))
	})

	// call once to get bigest feed
	let feedLock = false
	p2p.events.on('peer', () => {
		if(feedLock)
			return
		feedLock = true
		setTimeout(() => {
			p2p.emit('feed', null, (remoteFeed) => {
				if(!remoteFeed)
					return
        
				if(remoteFeed.length <= feed.size())
					return
        
				console.log('replace our feed with remote feed')
				feed.feed = remoteFeed
				send('feedUpdate', {
					feed: feed.feed
				});
			});
		}, 1000)
	})
    
}