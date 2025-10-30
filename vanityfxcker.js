"use strict";

const http2 = require("http2");
const WebSocket = require("ws");
const fs = require("fs").promises;
const dns = require("dns");
const { exec } = require("child_process");

dns.setDefaultResultOrder("ipv4first");
try {
  if (process.platform === "win32") {
    exec(`wmic process where processid="${process.pid}" CALL setpriority "high priority"`);
  }
} catch {}

let mfaToken = null;

const connectionPool = [];
const POOL_SIZE = 8;
const token = "token";
const targetGuildId = "serverid";
const channelId = "log kanal idsi ";
const guilds = {};
let vanity;

const createConnection = (index) => {
  const client = http2.connect('https://canary.discord.com');
  client.on('error', () => {
    setTimeout(() => {
      connectionPool[index] = createConnection(index);
    }, 1000);
  });
  client.on('close', () => {
    setTimeout(() => {
      connectionPool[index] = createConnection(index);
    }, 1000);
  });
  return client;
};

const createConnectionPool = () => {
  for (let i = 0; i < POOL_SIZE; i++) {
    connectionPool[i] = createConnection(i);
  }
};

createConnectionPool();

const extractJsonFromString = (str) => {
  const jsonRegex = /{[^{}]*}|\[[^\[\]]*\]/g;
  const matches = str.match(jsonRegex) || [];
  const results = [];
  
  for (const match of matches) {
    try {
      const parsed = JSON.parse(match);
      if (parsed) results.push(parsed);
    } catch {}
  }
  
  return results;
};

const readMFAToken = async () => { 
  try { 
    const fileContent = await fs.readFile('mfa.json', 'utf8');
    const jsonData = JSON.parse(fileContent);
    mfaToken = jsonData.token;
    return mfaToken;
  } catch {} 
  return mfaToken;
};

const log = async (data) => {
  const ext = extractJsonFromString(data.toString());
  const find = ext.find(e => e.code || e.message);
  if (find) {
    const client = connectionPool.find(c => c && !c.destroyed && !c.closed);
    if (client) {
      const body = {
        content: `@everyone ${vanity}\n\`\`\`json\n${JSON.stringify(find)}\`\`\``,
        weight: 255,
        exclusive: true
      };
      const req = client.request({
        ':method': 'POST',
        ':path': `/api/v9/channels/${channelId}/messages`,
        'authorization': token,
        'content-type': 'application/json'
      });
      req.on('error', () => {});
      req.write(JSON.stringify(body));
      req.end();
    }
  }
};

const sendPatchRequests = async (code) => {
  const promises = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const client = connectionPool[i];
    if (client && !client.destroyed && !client.closed) {
      promises.push(
        new Promise((resolve) => {
          const req = client.request({
            ':method': 'PATCH',
            ':path': `/api/v9/guilds/${targetGuildId}/vanity-url`,
            'authorization': token,
            'x-discord-mfa-authorization': mfaToken,
            'content-type': 'application/json',
            'user-agent': 'Chrome/124',
            'x-super-properties': 'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiQ2hyb21lIiwiZGV2aWNlIjoiIiwic3lzdGVtX2xvY2FsZSI6InRyLVRSIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzEyNC4wLjAuMCBTYWZhcmkvNTM3LjM2IiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTI0LjAuMC4wIiwib3NfdmVyc2lvbiI6IjEwIn0='
          }, { priority: { weight: 255, exclusive: true } });
          let responseData = '';
          req.on('data', (chunk) => { responseData += chunk; });
          req.on('end', () => { log(responseData); resolve(); });
          req.on('error', () => resolve());
          req.write(JSON.stringify({ code, weight: 255, exclusive: true }));
          req.end();
        })
      );
    }
  }
  await Promise.all(promises);
};

readMFAToken();

setInterval(() => {
  readMFAToken();
}, 10000);

setInterval(() => {
  connectionPool.forEach(client => {
    if (client && !client.destroyed && !client.closed) {
      const req = client.request({
        ':method': 'HEAD',
        ':path': '/api/users/@me',
        'authorization': token,
      });
      req.on('error', () => {});
      req.end();
    }
  });
}, 2000);

const websocket = new WebSocket("wss://gateway.discord.gg/");

websocket.onclose = (event) => {
  console.log(`ws connection closed ${event.reason} ${event.code}`);
  process.exit();
};

websocket.onmessage = async (message) => {
  const { d, op, t } = JSON.parse(message.data);

  if (t === "GUILD_UPDATE") {
    const find = guilds[d.guild_id];
    if (find && find !== d.vanity_url_code) {
      vanity = find;
      console.log(` Guild: ${d.guild_id}  Old: ${find} New: ${d.vanity_url_code || 'Artik yok xd'}`);
      sendPatchRequests(find);
    }
    if (d.vanity_url_code) {
      guilds[d.guild_id] = d.vanity_url_code;
    }
  } else if (t === "GUILD_DELETE") {
    const find = guilds[d.id];
    if (find) {
      vanity = find;
      console.log(` Guild DELETE: ${d.id}  Vanity: ${find}`);
      sendPatchRequests(find);
      delete guilds[d.id];
    }
  } else if (t === "READY") {
    d.guilds.forEach((guild) => {
      if (guild.vanity_url_code) {
        guilds[guild.id] = guild.vanity_url_code;
      }
    });
    console.log(`${Object.keys(guilds).length}  vanity urller`);
    console.log(guilds);
  }

  if (op === 10) {
    websocket.send(JSON.stringify({
      op: 2,
      d: {
        token: token,
        intents: (1 << 0) | (1 << 9),
        properties: {
          os: "Linux",
          browser: "Firefox",
          device: "Firefox",
        },
        weight: 255,
        exclusive: true,
      },
    }));

    setTimeout(() => {
      setInterval(() => {
        if (websocket.readyState === 1) {
          websocket.send(JSON.stringify({ 
            op: 1, 
            d: {}, 
            s: null, 
            t: "heartbeat" 
          }));
        }
      }, d.heartbeat_interval);
    }, d.heartbeat_interval * Math.random());
  } else if (op === 7) {
    process.exit();
  }
};
