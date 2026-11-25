// One made-up row per table that holds people, in the shape each vendor's API reference gives.
// Every value under `gone` is invented and must not survive the loader. Every value under `kept`
// must. Nothing here came from a real account.

export type PeopleFixture = { row: Record<string, unknown>; gone: string[]; kept: string[]; freeText?: string[] }

const P = {
  first: 'Testina',
  last: 'McFixture',
  full: 'Testina McFixture',
  email: 'testina.fixture@example.org',
  email2: 'second.fixture@example.org',
  phone: '+1 555 010 0199',
  phone2: '(555) 010-0142',
  street: '12 Made Up Lane',
  zip: '00000-1234',
  handle: 'testina_fx',
  ip: '203.0.113.77',
}

export const PEOPLE_FIXTURES: Record<string, Record<string, PeopleFixture>> = {
  zendesk: {
    users: {
      row: {
        id: 9001, url: 'https://example.zendesk.com/api/v2/users/9001.json', name: P.full, alias: P.handle, email: P.email, phone: P.phone, shared_phone_number: false,
        role: 'end-user', locale: 'en-US', time_zone: 'Pacific Time (US & Canada)', iana_time_zone: 'America/Los_Angeles', organization_id: 77, tags: ['vip'],
        signature: `Cheers, ${P.first}`, notes: `Prefers a call on ${P.phone2}`, details: `Reach at ${P.email2}`, photo: { id: 5, content_url: 'https://example.zendesk.com/photos/testina.png' },
        user_fields: { shoe_size: 'fixture-size-9' }, external_id: 'ext-9001', verified: true, created_at: '2026-01-02T03:04:05Z',
      },
      gone: [P.full, P.first, P.handle, P.email, P.phone, P.phone2, P.email2, 'testina.png', 'fixture-size-9'],
      kept: ['end-user', 'America/Los_Angeles', 'ext-9001', 'vip', 'Prefers a call on'],
      freeText: ['Prefers a call on', 'Reach at'],
    },
    tickets: {
      row: {
        id: 31, subject: `Refund for ${P.email}`, raw_subject: 'Refund please', description: `Call me on ${P.phone}`, status: 'open', priority: 'high', requester_id: 9001, assignee_id: 12, submitter_id: 9001,
        recipient: P.email2, via: { channel: 'email', source: { from: { address: P.email, name: P.full }, to: { name: 'Fixture Store' } } }, tags: ['refund'], custom_fields: [{ id: 1, value: `ring ${P.phone2}` }],
        satisfaction_rating: { score: 'good', comment: 'Thanks' }, generated_timestamp: 1767225600,
      },
      gone: [P.email, P.phone, P.email2, P.full, P.phone2],
      kept: ['open', 'high', 'email', 'refund', 'Refund please', 'good'],
      freeText: ['Refund please', 'Call me on'],
    },
  },
  gorgias: {
    customers: {
      row: {
        id: 501, name: P.full, firstname: P.first, lastname: P.last, email: P.email, external_id: 'shop-501', language: 'en', timezone: 'UTC', note: `VIP, mobile ${P.phone}`,
        channels: [{ id: 1, type: 'email', address: P.email, preferred: true }, { id: 2, type: 'phone', address: P.phone }], data: { nickname: P.handle }, meta: { name_set_via: 'helpdesk' },
        created_datetime: '2026-02-03T00:00:00Z',
      },
      gone: [P.full, P.first, P.last, P.email, P.phone, P.handle],
      kept: ['shop-501', 'UTC', 'preferred'],
      freeText: ['VIP, mobile'],
    },
    tickets: {
      row: {
        id: 77, subject: 'Where is my order', excerpt: `It is ${P.first} here, write to ${P.email}`, status: 'closed', channel: 'email', customer: { id: 501, name: P.full, email: P.email, firstname: P.first },
        assignee_user: { id: 4, name: 'Agent Fixture', email: 'agent.fixture@example.org' }, messages_count: 3, created_datetime: '2026-02-04T00:00:00Z',
      },
      gone: [P.full, P.email, 'Agent Fixture', 'agent.fixture@example.org'],
      kept: ['closed', 'Where is my order'],
      freeText: ['Where is my order'],
    },
  },
  recharge: {
    customers: {
      row: { id: 1101, email: P.email, first_name: P.first, last_name: P.last, phone: P.phone, hash: 'fixturehash1101', external_customer_id: { ecommerce: '7001' }, subscriptions_active_count: 2, tax_exempt: false, created_at: '2026-03-01T00:00:00+00:00' },
      gone: [P.email, P.first, P.last, P.phone, 'fixturehash1101'],
      kept: ['7001'],
    },
    orders: {
      row: {
        id: 2201, status: 'success', total_price: '48.00', currency: 'USD', note: `Leave with ${P.first} at the door`, customer: { id: 1101, email: P.email, hash: 'fixturehash1101' },
        billing_address: { first_name: P.first, last_name: P.last, address1: P.street, city: 'Fixtureville', zip: P.zip, country_code: 'US', phone: P.phone },
        shipping_address: { first_name: P.first, address1: P.street, zip: P.zip }, line_items: [{ title: 'Fixture Coffee', sku: 'FC-1', quantity: 2 }],
      },
      gone: [P.email, P.last, P.street, P.zip, P.phone, 'fixturehash1101'],
      kept: ['success', '48.00', 'Fixture Coffee', 'FC-1'],
      freeText: ['at the door'],
    },
  },
  'smile-io': {
    customers: {
      row: { id: 3001, first_name: P.first, last_name: P.last, email: P.email, state: 'member', points_balance: 240, referral_url: 'https://example.org/r/abc', date_of_birth: '1990-01-02', vip_tier_id: 2, created_at: '2026-01-01T00:00:00Z' },
      gone: [P.first, P.last, P.email, '1990-01-02'],
      kept: ['member', 'https://example.org/r/abc'],
    },
  },
  omnisend: {
    contacts: {
      row: {
        contactID: 'c-4001', email: P.email, firstName: P.first, lastName: P.last, phone: [P.phone], country: 'Canada', countryCode: 'CA', state: 'Ontario', city: 'Fixtureville', address: P.street, postalCode: P.zip,
        gender: 'f', birthdate: '1990-01-02', status: 'subscribed', tags: ['source: popup'], identifiers: [{ id: P.phone, type: 'phone', channels: { sms: { status: 'subscribed' } } }, { id: P.email, type: 'email' }],
        customProperties: { pet_name: 'Fixture the Cat' }, createdAt: '2026-04-01T00:00:00Z',
      },
      gone: [P.email, P.first, P.last, P.phone, P.street, P.zip, '1990-01-02', 'Fixture the Cat'],
      kept: ['c-4001', 'Canada', 'Ontario', 'Fixtureville', 'subscribed', 'source: popup'],
    },
  },
  privy: {
    contacts: {
      row: { id: 'cus_fixture1', email: P.email, first_name: P.first, last_name: P.last, phone_number: P.phone, email_status: 'subscribed', sms_status: 'unsubscribed', custom_fields: { birthday_wish: 'fixture-wish' }, tags: ['gold'], created_at: '2026-05-01T00:00:00Z' },
      gone: [P.email, P.first, P.last, P.phone, 'fixture-wish'],
      kept: ['cus_fixture1', 'subscribed', 'gold'],
    },
  },
  stamped: {
    customers: {
      row: { customerId: 'st-5001', email: P.email, firstName: P.first, lastName: P.last, name: P.full, phone: P.phone, points: 120, vipTier: 'silver', country: 'US', dateCreated: '2026-06-01T00:00:00Z' },
      gone: [P.email, P.first, P.last, P.full, P.phone],
      kept: ['st-5001', 'silver', 'US'],
    },
  },
  skio: {
    customers: {
      row: { id: 'sk-6001', platformId: 'gid://shopify/Customer/6001', siteId: 'site-1', shopifyTags: ['subscriber'], smsTransactionalOptIn: true, createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-02T00:00:00Z', redactedAt: null, removedAt: null, email: P.email, firstName: P.first, phoneNumber: P.phone },
      gone: [P.email, P.first, P.phone],
      kept: ['sk-6001', 'gid://shopify/Customer/6001', 'subscriber'],
    },
  },
  loyaltylion: {
    customers: {
      row: { id: 7001, merchant_id: 'shop-7001', email: P.email, points_approved: 500, points_pending: 0, birthday: '1990-01-02', referral_url: 'https://example.org/ll/7001', properties: { nickname: P.handle, favourite: 'fixture-fav' }, metadata: { source: 'fixture-meta' }, loyalty_tier_membership: { loyalty_tier: { id: 1, name: 'Bronze' } }, enrolled: true },
      gone: [P.email, '1990-01-02', P.handle, 'fixture-fav', 'fixture-meta'],
      kept: ['shop-7001', 'https://example.org/ll/7001'],
    },
  },
  kustomer: {
    customers: {
      row: {
        id: 'ku-8001', type: 'customer', attributes: {
          name: P.full, displayName: P.first, firstName: P.first, lastName: P.last, username: P.handle, avatarUrl: 'https://example.org/avatars/testina.png', externalId: 'ext-8001',
          emails: [{ email: P.email, verified: true }], phones: [{ phone: P.phone, type: 'mobile' }], socials: [{ type: 'twitter', username: P.handle, url: 'https://example.org/social/testina_page' }],
          locations: [{ address: P.street, countryCode: 'US', regionCode: 'CA' }], custom: { loyaltyStr: 'fixture-custom' }, sentiment: { polarity: 1 }, locale: 'en_US', timeZone: 'UTC', createdAt: '2026-08-01T00:00:00Z',
        },
      },
      gone: [P.full, P.first, P.last, P.handle, 'testina.png', P.email, P.phone, P.street, 'testina_page', 'fixture-custom'],
      kept: ['ku-8001', 'ext-8001', 'en_US', 'UTC'],
    },
    messages: {
      row: { id: 'msg-1', type: 'message', attributes: { channel: 'sms', direction: 'in', preview: `Hi it is ${P.email}`, subject: 'Order question', meta: { from: P.phone, to: '+15550100100' }, createdAt: '2026-08-02T00:00:00Z' } },
      gone: [P.phone, P.email, '+15550100100'],
      kept: ['sms', 'Order question'],
      freeText: ['Order question', 'Hi it is'],
    },
  },
  freshdesk: {
    contacts: {
      row: { id: 9101, name: P.full, email: P.email, phone: P.phone, mobile: P.phone2, twitter_id: P.handle, facebook_id: 'fb-testina', address: P.street, job_title: 'Buyer', description: `Met at the fair, ${P.email2}`, other_emails: [P.email2], avatar: { avatar_url: 'https://example.org/a/testina.jpg' }, custom_fields: { vip_note: 'fixture-vip' }, language: 'en', time_zone: 'Eastern Time (US & Canada)', company_id: 44, active: true, updated_at: '2026-09-01T00:00:00Z' },
      gone: [P.full, P.email, P.phone, P.phone2, P.handle, 'fb-testina', P.street, P.email2, 'testina.jpg', 'fixture-vip'],
      kept: ['Buyer', 'en', 'Eastern Time (US & Canada)'],
      freeText: ['Met at the fair'],
    },
    tickets: {
      row: { id: 61, subject: 'Late parcel', description_text: `Ring ${P.phone}`, name: P.full, email: P.email, phone: P.phone, requester_id: 9101, responder_id: 3, status: 2, priority: 1, cc_emails: [P.email2], to_emails: ['help.fixture@example.org'], twitter_id: P.handle, custom_fields: { cf_order: 'FX-100' }, tags: ['shipping'], updated_at: '2026-09-02T00:00:00Z' },
      gone: [P.full, P.email, P.phone, P.email2, 'help.fixture@example.org', P.handle],
      kept: ['Late parcel', 'FX-100', 'shipping'],
      freeText: ['Late parcel', 'Ring', 'FX-100'],
    },
  },
  'judge-me': {
    reviews: {
      row: { id: 1, title: 'Lovely', body: `Great, ask me at ${P.email}`, rating: 5, product_external_id: 123, product_title: 'Fixture Mug', product_handle: 'fixture-mug', reviewer: { id: 9, external_id: 77, email: P.email, name: P.full, phone: P.phone, tags: ['fixture-tag'], accepts_marketing: true }, ip_address: P.ip, source: 'web', verified: 'buyer', published: true, created_at: '2026-10-01T00:00:00Z' },
      gone: [P.email, P.full, P.phone, P.ip, 'fixture-tag'],
      kept: ['Lovely', 'Fixture Mug', 'fixture-mug', 'buyer', 'Great, ask me at'],
      freeText: ['Lovely', 'Great, ask me at'],
    },
  },
  'yotpo-reviews': {
    reviews: {
      row: { id: 2, title: 'Works well', content: `Call ${P.phone2} if you want details`, score: 4, votes_up: 1, votes_down: 0, name: P.full, email: P.email, reviewer_type: 'verified_buyer', sku: 'FX-2', sentiment: 0.9, deleted: false, created_at: '2026-10-02T00:00:00Z' },
      gone: [P.full, P.email, P.phone2],
      kept: ['Works well', 'verified_buyer', 'FX-2', 'if you want details'],
      freeText: ['Works well', 'if you want details'],
    },
    questions: {
      row: { id: 3, content: 'Does it fit a size 9?', name: P.full, email: P.email, created_at: '2026-10-03T00:00:00Z', product: { id: 5, name: 'Fixture Shoe' } },
      gone: [P.full, P.email],
      kept: ['Does it fit a size 9?', 'Fixture Shoe'],
      freeText: ['Does it fit a size 9?'],
    },
  },
  okendo: {
    reviews: {
      row: { reviewId: 'ok-1', title: 'Soft', body: 'Very soft fabric', rating: 5, status: 'approved', productName: 'Fixture Tee', reviewer: { displayName: 'Testina M.', name: P.full, email: P.email, avatarUrl: 'https://example.org/av/testina.jpg', isVerified: true, verifiedStatus: 'Verified Buyer', location: { zoneCode: 'FXZ', countryCode: 'US' } }, dateCreated: '2026-10-04T00:00:00Z' },
      gone: [P.full, 'Testina M.', P.email, 'testina.jpg', 'FXZ'],
      kept: ['ok-1', 'approved', 'Fixture Tee', 'Verified Buyer', 'Very soft fabric'],
      freeText: ['Soft', 'Very soft fabric'],
    },
  },
  loox: {
    product_reviews: {
      row: { id: 'lx-1', rating: 5, body: 'Arrived quickly', status: 'published', verified: true, reviewer: { name: P.full, firstName: P.first, lastName: P.last, nickname: P.handle, email: P.email, customerId: '5234' }, product: { id: '78', name: 'Fixture Lamp' }, location: { country: 'United States', countryCode: 'US' }, createdAt: '2026-10-05T00:00:00Z' },
      gone: [P.full, P.first, P.last, P.handle, P.email],
      kept: ['lx-1', 'published', 'Fixture Lamp', 'United States', 'Arrived quickly', '5234'],
      freeText: ['Arrived quickly'],
    },
  },
  shipstation: {
    shipments: {
      row: { shipment_id: 'se-1', shipment_status: 'pending', carrier_id: 'se-carrier', ship_to: { name: P.full, phone: P.phone, email: P.email, company_name: 'Fixture Co', address_line1: P.street, city_locality: 'Fixtureville', state_province: 'CA', postal_code: P.zip, country_code: 'US', instructions: `Gate code, ask ${P.first}` }, ship_from: { name: 'Warehouse Fixture', address_line1: '1 Depot Fixture Road' }, total_weight: { value: 2, unit: 'pound' }, modified_at: '2026-10-06T00:00:00Z' },
      gone: [P.full, P.phone, P.email, P.street, P.zip, 'Warehouse Fixture', '1 Depot Fixture Road'],
      kept: ['se-1', 'pending', 'Fixtureville', 'CA', 'US', 'pound'],
    },
  },
  'aftership-tracking': {
    trackings: {
      row: { id: 'af-1', tracking_number: 'FX123456789', slug: 'fixture-post', tag: 'Delivered', title: 'Order FX-9', order_id: 'FX-9', customers: [{ name: P.full, email: P.email, phone_number: P.phone, language: 'en' }], emails: [P.email], smses: [P.phone], signed_by: P.full, destination_raw_location: `${P.street}, Fixtureville`, destination_country_region: 'USA', destination_city: 'Fixtureville', note: `Leave with ${P.first}`, updated_at: '2026-10-07T00:00:00Z' },
      gone: [P.full, P.email, P.phone, P.street],
      kept: ['af-1', 'FX123456789', 'Delivered', 'USA', 'Fixtureville', 'Order FX-9'],
    },
  },
  're-amaze': {
    conversations: {
      row: { slug: 'conv-1', subject: 'Exchange', status: 0, author: { id: 5, name: P.full, email: P.email, mobile: P.phone, twitter: P.handle, friendly_name: P.first, display_name: P.first, data: { loyalty: 'fixture-data' } }, assignee: { name: 'Agent Fixture', email: 'agent.fixture@example.org' }, message: { body: `Please swap, ${P.email2}` }, tag_list: ['exchange'], created_at: '2026-10-08T00:00:00Z' },
      gone: [P.full, P.email, P.phone, P.handle, 'fixture-data', 'Agent Fixture', 'agent.fixture@example.org', P.email2],
      kept: ['conv-1', 'Exchange', 'exchange', 'Please swap'],
      freeText: ['Exchange', 'Please swap'],
    },
  },
  shippo: {
    transactions: {
      row: { object_id: 'tx-1', status: 'SUCCESS', tracking_number: 'FX999', label_url: 'https://example.org/labels/testina-label.pdf', commercial_invoice_url: null, metadata: `Customer ${P.email}`, rate: 'rate-1', object_created: '2026-10-09T00:00:00Z' },
      gone: ['testina-label.pdf', P.email],
      kept: ['tx-1', 'SUCCESS', 'FX999'],
    },
  },
  mailchimp: {
    ecommerce_orders: {
      row: { id: 'ord-1', store_id: 'store-1', order_total: 30, currency_code: 'USD', financial_status: 'paid', customer: { id: 'c1', email_address: P.email, first_name: P.first, last_name: P.last, company: 'Fixture Co', orders_count: 3, address: { address1: P.street, city: 'Fixtureville', postal_code: P.zip } }, shipping_address: { name: P.full, address1: P.street }, billing_address: { name: P.full, phone: P.phone }, lines: [{ id: 'l1', product_title: 'Fixture Soap', quantity: 1 }], processed_at_foreign: '2026-10-10T00:00:00Z' },
      gone: [P.email, P.first, P.last, P.street, P.zip, P.full, P.phone],
      kept: ['ord-1', 'paid', 'Fixture Soap', 'USD'],
    },
  },
  // 0.14.0
  'hubspot-records': {
    contacts: {
      row: {
        id: '51', properties: { createdate: '2026-11-01T09:00:00Z', lifecyclestage: 'lead', hs_analytics_source: 'ORGANIC_SEARCH', hs_object_id: '51', email: P.email, firstname: P.first, lastname: P.last, phone: P.phone, company: 'McFixture Holdings', jobtitle: 'Head of Fixtures' },
        createdAt: '2026-11-01T09:00:00Z', updatedAt: '2026-11-02T09:00:00Z', archived: false,
      },
      gone: [P.email, P.first, P.last, P.phone, 'McFixture Holdings', 'Head of Fixtures'],
      kept: ['ORGANIC_SEARCH', 'lead', '2026-11-01T09:00:00Z'],
    },
  },
  pipedrive: {
    leads: {
      row: {
        id: 'adf21080-0e10-11eb-879b-05d71fb426ec', title: `${P.full} inbound demo`, owner_id: 9, person_id: 78, organization_id: 13, source_name: 'Web forms', origin: 'WebForms', channel: 2,
        is_archived: false, value: { amount: 3000, currency: 'USD' }, add_time: '2026-11-03T10:00:00.000Z', cc_email: P.email,
      },
      gone: [P.full, P.email],
      kept: ['Web forms', 'WebForms', '3000', '2026-11-03T10:00:00.000Z'],
    },
  },
  shipbob: {
    orders: {
      row: { id: 801, order_number: 'FX-801', status: 'Fulfilled', gift_message: `Happy day from ${P.first}, ${P.phone2}`, recipient: { name: P.full, email: P.email, phone_number: P.phone, address: { address1: P.street, city: 'Fixtureville', state: 'CA', zip_code: P.zip, country: 'US' } }, products: [{ id: 1, sku: 'FX-SKU', quantity: 1 }], created_date: '2026-10-11T00:00:00Z' },
      gone: [P.full, P.email, P.phone, P.street, P.zip, P.phone2],
      kept: ['FX-801', 'Fulfilled', 'FX-SKU'],
    },
  },
}
