const pathToRegExp = require('path-to-regexp');
const wrapper = require('co-redis');
const readall = require('readall');
const Redis = require('redis');
const BloomFilter = require('bloomfilter-redis');

module.exports = function (options) {
  options = options || {};
  let redisAvailable = false;
  const redisOptions = options.redis || {};

  const prefix = options.prefix || 'bloom-cache:';
  const expire = options.expire || 30 * 60;
  const routes = options.routes || ['(.*)'];
  const exclude = options.exclude || [];
  const passParam = options.passParam || '';
  const maxLength = options.maxLength || Infinity;
  const onerror = options.onerror || function () {
    };
  redisOptions.port = redisOptions.port || 6379;

  redisOptions.host = redisOptions.host || 'localhost';
  redisOptions.url = redisOptions.url || `redis://${redisOptions.host}:${redisOptions.port}/`;
  const redisClient = wrapper(Redis.createClient(redisOptions.url, redisOptions.options));

  const bloomOptions = {
    redisSize: options.bloomSize || 256,
    hashesNum: options.bloomHash || 16,
    redisKey: options.bloomPrefix || 'bloom-filter',
    redisClient: redisClient
  };

  const bloomFilter = new BloomFilter(bloomOptions);

  redisClient.on('error', (error) => {
    redisAvailable = false;
    onerror(error);
  });

  redisClient.on('end', () => {
    redisAvailable = false;
  });

  redisClient.on('connect', () => {
    redisAvailable = true;
  });

  return async function cache (ctx, next) {
    const url = ctx.request.url;
    const path = ctx.request.path;
    const resolvedPrefix = typeof prefix === 'function' ? prefix.call(ctx, ctx) : prefix;
    const key = resolvedPrefix + url;
    const tkey = `${key}:type`;
    let match = false;
    let routeExpire = false;

    for (let i = 0; i < routes.length; i++) {
      let route = routes[i];

      if (typeof routes[i] === 'object') {
        route = routes[i].path;
        routeExpire = routes[i].expire;
      }

      if (paired(route, path)) {
        match = true;
        break;
      }
    }

    for (let j = 0; j < exclude.length; j++) {
      if (paired(exclude[j], path)) {
        match = false;
        break;
      }
    }

    if (!redisAvailable || !match || (passParam && ctx.request.query[passParam])) {
      return await next();
    }

    let ok = false;
    try {
      ok = await getCache(ctx, key, tkey);
    } catch (e) {
      ok = false;
    }
    if (ok) {
      return;
    }

    await next();

    try {
      const trueExpire = routeExpire || expire;
      await setCache(ctx, key, tkey, trueExpire);
    } catch (e) {
    }
    routeExpire = false;
  };

  async function getCache (ctx, key, tkey) {
    if (!checkBloom(key, ctx)) {
      ctx.response.set('X-Koa-Cache', 'MISS');
      ctx.response.set('X-Bloom', 'MISS');
      return false;
    }
    const value = await redisClient.get(key);
    let type;
    let ok = false;

    if (value) {
      ctx.response.status = 200;
      type = (await redisClient.get(tkey)) || 'text/html';
      // can happen if user specified return_buffers: true in redis options
      if (Buffer.isBuffer(type)) type = type.toString();
      ctx.response.set('X-Cache', 'HIT');
      ctx.response.set('X-Koa-Cache', 'HIT');
      ctx.response.type = type;
      ctx.response.body = value;
      ok = true;
    }

    return ok;
  }

  async function setCache (ctx, key, tkey, expire) {
    let body = ctx.response.body;

    if ((ctx.request.method !== 'GET') || (ctx.response.status !== 200) || !body) {
      return;
    }

    if (typeof body === 'string') {
      // string
      if (Buffer.byteLength(body) > maxLength) return;
      await redisClient.setex(key, expire, body);
    } else if (Buffer.isBuffer(body)) {
      // buffer
      if (body.length > maxLength) return;
      await redisClient.setex(key, expire, body);
    } else if (typeof body === 'object' && ctx.response.type === 'application/json') {
      // JSON
      body = JSON.stringify(body);
      if (Buffer.byteLength(body) > maxLength) return;
      await redisClient.setex(key, expire, body);
    } else if (typeof body.pipe === 'function') {
      // stream
      body = await read(body);
      ctx.response.body = body;
      if (Buffer.byteLength(body) > maxLength) return;
      await redisClient.setex(key, expire, body);
    } else {
      return;
    }
    addBloom(body, ctx);

    await cacheType(ctx, tkey, expire);
  }

  async function cacheType (ctx, tkey, expire) {
    const type = ctx.response.type;
    if (type) {
      await redisClient.setex(tkey, expire, type);
    }
  }

  async function createBloom (ctx) {
    await bloomFilter.init({ redisKey: `${bloomOptions.redisKey}:${ctx.state.bloomHash}` });
  }

  async function addBloom (str, ctx) {
    await bloomFilter.add(str, { redisKey: `${bloomOptions.redisKey}:${ctx.state.bloomHash}` });
  }

  async function checkBloom (str, ctx) {
    return await bloomFilter.contains(str, { redisKey: `${bloomOptions.redisKey}:${ctx.state.bloomHash}` });
  }

  async function clearBloom (ctx) {
    await bloomFilter.init({ redisKey: `${bloomOptions.redisKey}:${ctx.state.bloomHash}` });
  }
};

function paired (route, path) {
  const options = {
    sensitive: true,
    strict: true
  };

  return pathToRegExp(route, [], options).exec(path);
}

function read (stream) {
  return new Promise((resolve, reject) => {
    readall(stream, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
}
