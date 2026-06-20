const { Snaptrade } = require('snaptrade-typescript-sdk');

async function main() {
  const snaptrade = new Snaptrade({
    clientId: process.env.SNAPTRADE_CLIENT_ID,
    consumerKey: process.env.SNAPTRADE_CONSUMER_KEY
  });

  const response = await snaptrade.authentication.registerSnapTradeUser({
    userId: process.env.SNAPTRADE_USER_ID
  });

  console.log(response.data);
}

main().catch(err => {
  console.error("Message:", err.message);
  console.error("Name:", err.name);
  console.error("Keys:", Object.keys(err));

  console.error("Full error:");
  console.dir(err, { depth: 10 });

  process.exit(1);
});
