const { Snaptrade } = require('snaptrade-typescript-sdk');

async function main() {
  const snaptrade = new Snaptrade({
    clientId: process.env.SNAPTRADE_CLIENT_ID,
    consumerKey: process.env.SNAPTRADE_CONSUMER_KEY
  });

  const response = await snaptrade.accountInformation.listUserAccounts({
    userId: process.env.SNAPTRADE_USER_ID,
    userSecret: process.env.SNAPTRADE_USER_SECRET
  });

  console.dir(response.data, { depth: 10 });
}

main().catch(err => {
  console.error("Status:", err.status);
  console.error("Body:", err.responseBody);
  console.error("Message:", err.message);
  process.exit(1);
});
