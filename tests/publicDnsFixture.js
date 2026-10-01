const dns = require('dns').promises;

// Configuration tests store an example.com target; they never contact it.
// Keep its public DNS answer deterministic even on offline development hosts.
function mockPublicExampleDns() {
  const lookup = dns.lookup.bind(dns);
  return jest.spyOn(dns, 'lookup').mockImplementation((host, options) => {
    if (host !== 'example.com') return lookup(host, options);
    const address = { address: '8.8.8.8', family: 4 };
    return Promise.resolve(options?.all ? [address] : address);
  });
}
module.exports = { mockPublicExampleDns };
