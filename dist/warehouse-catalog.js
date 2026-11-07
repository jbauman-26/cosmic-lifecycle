export const READINESS_LEGEND = 'Readiness: native = built in with reconcile checks. tested = warehouse connector run on a real account. built = connector written from the vendor API docs, not yet run on a real account. planned = no connector yet; use lifecycle sources import meanwhile.';
export const WAREHOUSE_CATALOG = [
    {
        "slug": "meta-ads",
        "name": "Meta Ads (Facebook and Instagram)",
        "category": "ads",
        "readiness": "planned",
        "why": "#2 of 100 tools Shopify stores use. StoreLeads: detected on 738,495 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/technology/Facebook%20Pixel",
        "docs": "https://developers.facebook.com/docs/marketing-apis",
        "credentials": [],
        "params": [],
        "notes": "Needs an OAuth sign-in flow, not built yet. CSV import meanwhile."
    },
    {
        "slug": "google-ads",
        "name": "Google Ads",
        "category": "ads",
        "readiness": "planned",
        "why": "#3 of 100 tools Shopify stores use. StoreLeads State of Shopify report: Google Ads Pixel detected on 1,124,947 Shopify stores. Source: https://storeleads.app/reports/shopify",
        "docs": "https://developers.google.com/google-ads/api/docs/start",
        "credentials": [],
        "params": [],
        "notes": "Needs an OAuth sign-in flow, not built yet. CSV import meanwhile."
    },
    {
        "slug": "tiktok-ads",
        "name": "TikTok Ads",
        "category": "ads",
        "readiness": "planned",
        "why": "#5 of 100 tools Shopify stores use. StoreLeads: detected on 414,088 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/technology/TikTok%20Pixel",
        "docs": "https://business-api.tiktok.com/portal/docs",
        "credentials": [],
        "params": [],
        "notes": "Needs an OAuth sign-in flow, not built yet. CSV import meanwhile."
    },
    {
        "slug": "judge-me",
        "name": "Judge.me",
        "category": "reviews",
        "readiness": "built",
        "why": "#6 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 650,821 Shopify stores (Oct 30 2026 snapshot). Most installed Shopify app overall (20.2% of stores). Source: https://storeleads.app/reports/shopify/app/judgeme",
        "docs": "https://judge.me/api/docs",
        "credentials": [
            {
                "name": "api_token",
                "label": "Private API token",
                "help": "Judge.me admin, Settings, Integrations, then the View API tokens button at the top right. Copy the Private API token. Judge.me does not offer read-only scopes: the private token is read/write, so store it as a secret. This connector only sends GET requests."
            }
        ],
        "params": [
            {
                "name": "shop_domain",
                "label": "Shop domain (myshopify.com)",
                "example": "example-store.myshopify.com"
            }
        ],
        "config": {
            "client": {
                "base_url": "https://api.judge.me/api/v1/",
                "auth": {
                    "type": "api_key",
                    "name": "X-Api-Token",
                    "api_key": "{secret:api_token}",
                    "location": "header"
                }
            },
            "resource_defaults": {
                "primary_key": "id",
                "write_disposition": "merge",
                "endpoint": {
                    "params": {
                        "shop_domain": "{param:shop_domain}"
                    }
                }
            },
            "resources": [
                {
                    "name": "reviews",
                    "endpoint": {
                        "path": "reviews",
                        "params": {
                            "per_page": 100
                        },
                        "data_selector": "reviews",
                        "paginator": {
                            "type": "page_number",
                            "base_page": 1,
                            "page_param": "page",
                            "total_path": null,
                            "stop_after_empty_page": true
                        }
                    }
                },
                {
                    "name": "shop_info",
                    "endpoint": {
                        "path": "shops/info",
                        "data_selector": "shop",
                        "paginator": {
                            "type": "single_page"
                        }
                    }
                }
            ]
        },
        "notes": "Reviews list returns current_page, per_page and reviews with no total count or next link, so pagination is page_number stopping on the first empty page. per_page maximum 100 per the help article (API reference gives no max). No updated_at or created_at filter is documented, so reviews is a full refresh merged on id; large shops will re-read every review each run. The public API has no list endpoints for products, questions or reviewers (only single lookups), so they are not included. shop_info id is returned as a string. No rate limit is documented."
    },
    {
        "slug": "recharge",
        "name": "Recharge",
        "category": "subscriptions",
        "readiness": "built",
        "why": "#7 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 50,634 Shopify stores (Oct 30 2026 snapshot). Vendor claim cited by Solo Media Group: powers 71% of subscriptions sold on Shopify stores. Alium: appears only in Shopify stacks. Source: https://storeleads.app/reports/shopify/app/subscription-payments",
        "docs": "https://developer.rechargepayments.com/2021-11/",
        "credentials": [
            {
                "name": "api_token",
                "label": "Admin API token",
                "help": "Recharge merchant portal, Tools & apps, API tokens, then Create new in the Admin token section (not the Storefront token). Name it, and under scopes set Read access for Subscriptions, Orders (covers charges and orders) and Customers; leave every other scope at No access. Copy the token after saving."
            }
        ],
        "params": [],
        "config": {
            "client": {
                "base_url": "https://api.rechargeapps.com/",
                "headers": {
                    "X-Recharge-Version": "2021-11",
                    "Accept": "application/json"
                },
                "auth": {
                    "type": "api_key",
                    "name": "X-Recharge-Access-Token",
                    "api_key": "{secret:api_token}",
                    "location": "header"
                }
            },
            "resource_defaults": {
                "primary_key": "id",
                "write_disposition": "merge"
            },
            "resources": [
                {
                    "name": "subscriptions",
                    "endpoint": {
                        "path": "subscriptions",
                        "params": {
                            "limit": 250,
                            "updated_at_min": "{incremental.start_value}"
                        },
                        "data_selector": "subscriptions",
                        "paginator": {
                            "type": "cursor",
                            "cursor_path": "next_cursor",
                            "cursor_param": "cursor"
                        },
                        "incremental": {
                            "cursor_path": "updated_at",
                            "initial_value": "2015-01-01T00:00:00"
                        }
                    }
                },
                {
                    "name": "charges",
                    "endpoint": {
                        "path": "charges",
                        "params": {
                            "limit": 250,
                            "updated_at_min": "{incremental.start_value}"
                        },
                        "data_selector": "charges",
                        "paginator": {
                            "type": "cursor",
                            "cursor_path": "next_cursor",
                            "cursor_param": "cursor"
                        },
                        "incremental": {
                            "cursor_path": "updated_at",
                            "initial_value": "2015-01-01T00:00:00"
                        }
                    }
                },
                {
                    "name": "orders",
                    "endpoint": {
                        "path": "orders",
                        "params": {
                            "limit": 250,
                            "updated_at_min": "{incremental.start_value}"
                        },
                        "data_selector": "orders",
                        "paginator": {
                            "type": "cursor",
                            "cursor_path": "next_cursor",
                            "cursor_param": "cursor"
                        },
                        "incremental": {
                            "cursor_path": "updated_at",
                            "initial_value": "2015-01-01T00:00:00"
                        }
                    }
                },
                {
                    "name": "customers",
                    "endpoint": {
                        "path": "customers",
                        "params": {
                            "limit": 250,
                            "updated_at_min": "{incremental.start_value}"
                        },
                        "data_selector": "customers",
                        "paginator": {
                            "type": "cursor",
                            "cursor_path": "next_cursor",
                            "cursor_param": "cursor"
                        },
                        "incremental": {
                            "cursor_path": "updated_at",
                            "initial_value": "2015-01-01T00:00:00"
                        }
                    }
                }
            ]
        },
        "notes": "Pinned to API version 2021-11 via the X-Recharge-Version header, where list responses carry next_cursor and previous_cursor in the body (2021-01 puts them in a Link header instead). limit max is 250. Incremental uses the documented updated_at_min filter with cursor_path updated_at. Uncertain: the docs only show cursor examples as ?limit=250&cursor=..., and do not say whether filters like updated_at_min may be resent with the cursor; dlt resends the original params on every page. If page 2 errors or ignores the filter, drop incremental and run full refresh with limit only. An automated read of the charges and orders reference pages reported response keys named next/previous rather than next_cursor; the 2021-11 cursor pagination page states next_cursor is included in all list responses, so next_cursor is used. Verify on first live run. Rate limits were not checked; dlt retries 429 responses."
    },
    {
        "slug": "gorgias",
        "name": "Gorgias",
        "category": "helpdesk",
        "readiness": "built",
        "why": "#8 of 100 tools Shopify stores use. StoreLeads: detected on 25,584 Shopify stores (Oct 30 2026 snapshot). Alium: run by about one in five Shopify brands interviewed. Source: https://storeleads.app/reports/technology/Gorgias",
        "docs": "https://developers.gorgias.com/reference/introduction",
        "credentials": [
            {
                "name": "api_key",
                "label": "REST API key (password)",
                "help": "Gorgias helpdesk, Settings, You, REST API. Under API Access & Credentials click Create API Key (or copy the existing Password (API Key)). Gorgias keys have no scopes: the key acts with the permissions of the user who owns it, so create it from a user with the lowest role that can see all tickets. This connector only sends GET requests."
            }
        ],
        "params": [
            {
                "name": "subdomain",
                "label": "Gorgias subdomain (the part before .gorgias.com)",
                "example": "acme-store"
            },
            {
                "name": "username",
                "label": "Gorgias account email (REST API Username)",
                "example": "ops@acme-store.com"
            }
        ],
        "config": {
            "client": {
                "base_url": "https://{param:subdomain}.gorgias.com/api/",
                "auth": {
                    "type": "http_basic",
                    "username": "{param:username}",
                    "password": "{secret:api_key}"
                }
            },
            "resource_defaults": {
                "primary_key": "id",
                "write_disposition": "merge"
            },
            "resources": [
                {
                    "name": "tickets",
                    "endpoint": {
                        "path": "tickets",
                        "params": {
                            "limit": 100,
                            "order_by": "updated_datetime:desc"
                        },
                        "data_selector": "data",
                        "paginator": {
                            "type": "cursor",
                            "cursor_path": "meta.next_cursor",
                            "cursor_param": "cursor"
                        }
                    }
                },
                {
                    "name": "customers",
                    "endpoint": {
                        "path": "customers",
                        "params": {
                            "limit": 100,
                            "order_by": "updated_datetime:desc"
                        },
                        "data_selector": "data",
                        "paginator": {
                            "type": "cursor",
                            "cursor_path": "meta.next_cursor",
                            "cursor_param": "cursor"
                        }
                    }
                },
                {
                    "name": "satisfaction_surveys",
                    "endpoint": {
                        "path": "satisfaction-surveys",
                        "params": {
                            "limit": 100,
                            "order_by": "created_datetime:desc"
                        },
                        "data_selector": "data",
                        "paginator": {
                            "type": "cursor",
                            "cursor_path": "meta.next_cursor",
                            "cursor_param": "cursor"
                        }
                    }
                }
            ]
        },
        "notes": "All lists use cursor pagination: response data plus meta.next_cursor, passed back as cursor. limit max 100 on each endpoint. No updated_datetime or created_datetime filter is documented on these list endpoints (only order_by), so every resource is a full refresh merged on id. List tickets defaults trashed=true, so trashed tickets are included; filter on trashed_datetime downstream if needed. Messages (GET /api/messages) were left out because without a date filter a full refresh would re-read every message each run; tickets already carry message counts and first/last message timestamps. Rate limit for API key integrations is 40 requests per 20 seconds (developers.gorgias.com/reference/limitations), so a large initial ticket load is slow; dlt retries 429s."
    },
    {
        "slug": "paypal",
        "name": "PayPal",
        "category": "payments",
        "readiness": "planned",
        "why": "#9 of 100 tools Shopify stores use. StoreLeads State of Shopify report: PayPal Express Checkout detected on 1,580,137 Shopify stores. Source: https://storeleads.app/reports/shopify",
        "docs": "https://developer.paypal.com/api/rest/",
        "credentials": [],
        "params": [],
        "notes": "Needs an OAuth sign-in flow, not built yet. CSV import meanwhile."
    },
    {
        "slug": "triple-whale",
        "name": "Triple Whale",
        "category": "analytics",
        "readiness": "built",
        "why": "#10 of 100 tools Shopify stores use. StoreLeads: detected on 37,854 Shopify stores (Oct 30 2026 snapshot). Alium: in about one in seven Shopify stacks, roughly 20x its rate on other platforms. Source: https://storeleads.app/reports/technology/Triple%20Whale",
        "docs": "https://triplewhale.readme.io/reference/introduction-to-the-triple-whale-api",
        "credentials": [
            {
                "name": "api_key",
                "label": "API key",
                "help": "Triple Whale app, Data, APIs (app.triplewhale.com/api-keys), Generate API Key. Name it, set an expiration (90 days default; pick a longer one or rotate on schedule), and select no Write scopes. Summary Page: Read and Pixel Attribution: Read are the read scopes; the docs list no specific scope for the SQL endpoint this connector uses. Leave Customer PII: Read off. Copy the key from the popup; it is shown once. Keys stop working if the creating user loses access."
            }
        ],
        "params": [
            {
                "name": "shop_domain",
                "label": "Shop ID (the shop-id value in your Triple Whale app URL)",
                "example": "example-store.myshopify.com"
            }
        ],
        "config": {
            "client": {
                "base_url": "https://api.triplewhale.com/api/v2/",
                "auth": {
                    "type": "api_key",
                    "name": "x-api-key",
                    "api_key": "{secret:api_key}",
                    "location": "header"
                }
            },
            "resource_defaults": {
                "write_disposition": "merge"
            },
            "resources": [
                {
                    "name": "ads_daily",
                    "primary_key": [
                        "event_date",
                        "channel",
                        "campaign_id"
                    ],
                    "endpoint": {
                        "path": "orcabase/api/sql",
                        "method": "POST",
                        "json": {
                            "shopId": "{param:shop_domain}",
                            "query": "SELECT event_date, channel, campaign_id, any(campaign_name) AS campaign_name, SUM(spend) AS spend, SUM(impressions) AS impressions, SUM(clicks) AS clicks, SUM(conversions) AS conversions, SUM(conversion_value) AS conversion_value FROM ads_table WHERE event_date >= today() - 30 AND event_date <= today() GROUP BY event_date, channel, campaign_id",
                            "period": {
                                "startDate": "2020-01-01",
                                "endDate": "2099-12-31"
                            }
                        },
                        "data_selector": "data",
                        "paginator": {
                            "type": "single_page"
                        }
                    }
                },
                {
                    "name": "pixel_attribution_daily",
                    "primary_key": [
                        "event_date",
                        "channel",
                        "campaign_id"
                    ],
                    "endpoint": {
                        "path": "orcabase/api/sql",
                        "method": "POST",
                        "json": {
                            "shopId": "{param:shop_domain}",
                            "query": "SELECT event_date, channel, campaign_id, any(campaign_name) AS campaign_name, SUM(spend) AS spend, SUM(order_revenue) AS order_revenue, SUM(orders_quantity) AS orders, SUM(new_customer_orders) AS new_customer_orders, SUM(new_customer_order_revenue) AS new_customer_order_revenue FROM pixel_joined_tvf() WHERE event_date >= today() - 30 AND event_date <= today() GROUP BY event_date, channel, campaign_id",
                            "period": {
                                "startDate": "2020-01-01",
                                "endDate": "2099-12-31"
                            }
                        },
                        "data_selector": "data",
                        "paginator": {
                            "type": "single_page"
                        }
                    }
                }
            ]
        },
        "notes": "Triple Whale has no GET data endpoints. Every Data-Out endpoint is a read-only POST: Summary Page (POST summary-page/get-data), Attribution (POST attribution/get-orders-with-journeys-v2) and Custom SQL (POST orcabase/api/sql). This spec uses only the Custom SQL endpoint, which returns {success, message, data:[rows]} in one response with no pagination. Both resources are aggregated to one row per day, channel and campaign (ads_table is channel-reported; pixel_joined_tvf is Triple Attribution model, lifetime window by default) and re-pull a rolling 31-day window each run, merged on (event_date, channel, campaign_id), so restated ad and attribution numbers are corrected. The runner has no 'today' placeholder, so the window is computed in ClickHouse with today() and the required period field is sent as a fixed wide range (2020-01-01 to 2099-12-31). Uncertain: the docs say to use @startDate and @endDate in the query; it is not confirmed whether the API rejects a query that does not reference them or a period whose endDate is in the future. If it does, switch the WHERE clause to event_date BETWEEN @startDate AND @endDate and send real dates. For a historical backfill, change today() - 30 once to a larger window. Summary Page was skipped because it returns a single unkeyed metric list per period and needs todayHour; Attribution journeys were skipped because they need a per-run date window and body-based page pagination (pageSize max 100) the runner cannot fill without a date placeholder. Rate limit header example is 100 calls per 60 seconds. Queries are aggregated to keep response size small."
    },
    {
        "slug": "attentive",
        "name": "Attentive",
        "category": "email-sms",
        "readiness": "planned",
        "why": "#11 of 100 tools Shopify stores use. StoreLeads: detected on 9,190 Shopify stores (Oct 30 2026 snapshot). Alium: nearly 2x more common at Shopify brands; about 3 in 4 also run Klaviyo. Source: https://storeleads.app/reports/technology/Attentive",
        "docs": "https://docs.attentive.com/",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "postscript",
        "name": "Postscript",
        "category": "email-sms",
        "readiness": "planned",
        "why": "#12 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 22,094 Shopify stores (Oct 30 2026 snapshot). Alium: Shopify-only in interview sample. Source: https://storeleads.app/reports/shopify/app/postscript-sms-marketing",
        "docs": "https://developers.postscript.io/",
        "credentials": [],
        "params": [],
        "notes": "Custom API access is enterprise-only, and it lists subscribers only. CSV import meanwhile."
    },
    {
        "slug": "yotpo-reviews",
        "name": "Yotpo Reviews",
        "category": "reviews",
        "readiness": "built",
        "why": "#13 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 36,288 Shopify stores (Oct 30 2026 snapshot). Alium: over 2x more common at Shopify brands. Source: https://storeleads.app/reports/shopify/app/yotpo-social-reviews",
        "docs": "https://docs.yotpo.com/docs/authenticate-and-make-your-first-call",
        "credentials": [
            {
                "name": "access_token",
                "label": "Yotpo access token",
                "help": "Must be the Yotpo account administrator. In Yotpo Reviews open the account menu (bottom left) > Account Settings > General Settings: copy the Store ID (app key) at the bottom, then click Get secret key, enter the emailed code and copy the API secret. Exchange them once for a token: POST https://api.yotpo.com/oauth/token with JSON {\"client_id\": \"<store id>\", \"client_secret\": \"<api secret>\", \"grant_type\": \"client_credentials\"} and paste the access_token value here. Yotpo has no read-only scope; the token carries full account rights, so keep it server side. If syncs start failing with 401, generate a new token the same way."
            }
        ],
        "params": [
            {
                "name": "store_id",
                "label": "Yotpo Store ID (app key)",
                "example": "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90"
            }
        ],
        "config": {
            "client": {
                "base_url": "https://api.yotpo.com/",
                "auth": {
                    "type": "api_key",
                    "name": "X-Yotpo-Token",
                    "api_key": "{secret:access_token}",
                    "location": "header"
                }
            },
            "resource_defaults": {
                "primary_key": "id",
                "write_disposition": "merge"
            },
            "resources": [
                {
                    "name": "reviews",
                    "endpoint": {
                        "path": "v1/apps/{param:store_id}/reviews",
                        "params": {
                            "count": 100,
                            "deleted": "true"
                        },
                        "data_selector": "reviews",
                        "paginator": {
                            "type": "page_number",
                            "page_param": "page",
                            "base_page": 1,
                            "total_path": null,
                            "stop_after_empty_page": true
                        },
                        "incremental": {
                            "start_param": "since_updated_at",
                            "cursor_path": "updated_at",
                            "initial_value": "2010-01-01"
                        }
                    }
                },
                {
                    "name": "questions",
                    "endpoint": {
                        "path": "apps/{param:store_id}/questions.json",
                        "params": {
                            "count": 100
                        },
                        "data_selector": "response.questions",
                        "paginator": {
                            "type": "page_number",
                            "page_param": "page",
                            "base_page": 1,
                            "total_path": null,
                            "stop_after_empty_page": true
                        }
                    }
                }
            ]
        },
        "notes": "Auth is a manual one-time token exchange. Yotpo turns Store ID plus API secret into an access token (POST /oauth/token, client_credentials) that must be sent in the X-Yotpo-Token header. dlt's oauth2_client_credentials auth can fetch that token but always sends it as Authorization: Bearer, which Yotpo documents only for the Insights API, not for Retrieve all reviews or questions, so it is not used here. The token has no documented lifetime; the docs say to regenerate on 401. Best fix later: let the runner exchange a stored api_secret for the token before each sync. reviews: max count is 100 per page (default 10), page/count paging with no total, so the paginator stops on the first empty page. Incremental uses since_updated_at, which the docs type as a date; dlt sends the last seen updated_at datetime string, which Yotpo is expected to accept but this is unverified; if it rejects it, drop the incremental block and run as full refresh with merge. deleted=true is sent so reviews removed in Yotpo come back with deleted=true instead of silently vanishing. Review data lags about 1 hour. questions: the reference lists only status_type as a parameter, but its own example uses count and page; count=100 is assumed (not documented as a max), full refresh with merge on id. Rate limit 5,000 requests per minute per app key on reviews."
    },
    {
        "slug": "okendo",
        "name": "Okendo",
        "category": "reviews",
        "readiness": "planned",
        "why": "#14 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 18,979 Shopify stores (Oct 30 2026 snapshot). Alium: Shopify-only; about one in nine Shopify brands interviewed. Source: https://storeleads.app/reports/shopify/app/okendo-reviews",
        "docs": "https://docs.okendo.io/merchant-rest-api/",
        "credentials": [],
        "params": [],
        "notes": "API is usable, but its relative next-page links need a custom pager in the runner. Planned. CSV import meanwhile."
    },
    {
        "slug": "loop-returns",
        "name": "Loop Returns",
        "category": "returns",
        "readiness": "built",
        "why": "#15 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 6,882 Shopify stores (Oct 30 2026 snapshot). Alium: Shopify-only; buyers call it the first returns app that comes to mind. Taylor Sicard lists it in the $5M core stack. Source: https://storeleads.app/reports/shopify/app/loop-returns",
        "docs": "https://docs.loopreturns.com/api-reference/getting-started",
        "credentials": [
            {
                "name": "api_key",
                "label": "Loop API key",
                "help": "Loop Admin (admin.loopreturns.com), Returns Management > Tools & integrations > Developer Tools, Generate API key. Tick only the Returns scope, plus Happy Returns Shipments (Read) if the brand uses Happy Returns drop-off. Do not add Carts, Orders write actions or Destinations (Write). Name it Cosmic Lifecycle and click Generate."
            }
        ],
        "params": [],
        "config": {
            "client": {
                "base_url": "https://api.loopreturns.com/api/2026-10/",
                "auth": {
                    "type": "api_key",
                    "name": "X-Authorization",
                    "api_key": "{secret:api_key}",
                    "location": "header"
                }
            },
            "resource_defaults": {
                "primary_key": "id",
                "write_disposition": "merge"
            },
            "resources": [
                {
                    "name": "returns",
                    "endpoint": {
                        "path": "warehouse/return/list",
                        "params": {
                            "paginate": "true",
                            "pageSize": 750,
                            "filter": "updated_at"
                        },
                        "data_selector": "returns",
                        "paginator": {
                            "type": "json_link",
                            "next_url_path": "nextPageUrl"
                        }
                    }
                },
                {
                    "name": "happy_returns_shipments",
                    "primary_key": "loop_shipment_id",
                    "endpoint": {
                        "path": "happy-returns/shipments",
                        "data_selector": "data",
                        "paginator": {
                            "type": "json_link",
                            "next_url_path": "next_page_url"
                        }
                    }
                }
            ]
        },
        "notes": "Rolling 24 hour window, not a backfill. Both list endpoints return only the last 24 hours when no from/to is sent, the returns list caps from/to at 120 days, and sending from without to returns only the 24 hours after from. A static dlt config cannot compute a moving to-date, so dlt incremental is not used: each run pulls every return updated in the last 24 hours (filter=updated_at, default states open, closed, expired) and merges on id. Run at least daily or rows are missed; cancelled and review-state returns are excluded by the API default. A historical backfill needs a one-off run with explicit from/to params in 120 day windows. returns: pageSize max is 750 per the pagination guide; nextPageUrl carries the cursor and the original filters, dlt follows it as-is. happy_returns_shipments: 200 per page fixed, needs the separate Happy Returns Shipments (Read) scope, so drop that resource if the key lacks it (it will 401). API version pinned to 2026-10 (current stable)."
    },
    {
        "slug": "rebuy",
        "name": "Rebuy",
        "category": "upsell-cro",
        "readiness": "planned",
        "why": "#16 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 14,787 Shopify stores (Oct 30 2026 snapshot). Alium: Shopify-only; cart layer other apps plug into. Source: https://storeleads.app/reports/shopify/app/rebuy",
        "docs": "https://developers.rebuyengine.com/",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "quickbooks-online",
        "name": "QuickBooks Online",
        "category": "accounting",
        "readiness": "planned",
        "why": "#17 of 100 tools Shopify stores use. Ranking position is judgment. No public Shopify install count found (backend app, not detectable by storefront scanners). A2X markets Shopify-to-QuickBooks/Xero sync to 13,000+ businesses. Source: https://www.a2xaccounting.com/",
        "docs": "https://developer.intuit.com/app/developer/qbo/docs/get-started",
        "credentials": [],
        "params": [],
        "notes": "Needs an OAuth sign-in flow, not built yet. CSV import meanwhile."
    },
    {
        "slug": "amazon-seller-central",
        "name": "Amazon Seller Central (SP-API)",
        "category": "marketplaces",
        "readiness": "planned",
        "why": "#18 of 100 tools Shopify stores use. Ranking position is judgment. No Shopify-specific count found. Amazon is the most common second channel for DTC brands; A2X is an Amazon Marketplace Developer Council member serving Shopify plus Amazon sellers. Source: https://www.a2xaccounting.com/blog/a2x-is-a-member-of-the-amazon-marketplace-developer-council",
        "docs": "https://developer-docs.amazon.com/sp-api/",
        "credentials": [],
        "params": [],
        "notes": "Needs an OAuth sign-in flow, not built yet. CSV import meanwhile."
    },
    {
        "slug": "klarna",
        "name": "Klarna",
        "category": "payments",
        "readiness": "planned",
        "why": "#19 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 367,973 Shopify stores (Oct 30 2026 snapshot). Third most installed Shopify app. Source: https://storeleads.app/reports/shopify/app/klarna-on-site-messaging",
        "docs": "https://docs.klarna.com/api/settlements/",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "afterpay",
        "name": "Afterpay (Cash App Afterpay)",
        "category": "payments",
        "readiness": "planned",
        "why": "#20 of 100 tools Shopify stores use. StoreLeads: detected on 119,740 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/technology/Afterpay",
        "docs": "https://developers.afterpay.com/",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "loox",
        "name": "Loox",
        "category": "reviews",
        "readiness": "planned",
        "why": "#21 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 128,396 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/loox",
        "docs": "https://developers.loox.app/documentation/",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "smile-io",
        "name": "Smile.io",
        "category": "loyalty",
        "readiness": "built",
        "why": "#22 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 58,160 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/smile-io",
        "docs": "https://dev.smile.io/api/introduction",
        "credentials": [
            {
                "name": "api_key",
                "label": "Smile API key",
                "help": "Needs the Plus or Enterprise plan. Smile Admin > Settings > Developer tools (app.smile.io/settings/developer-tools); add a technical contact at the top if asked. In the Manage API keys card click Generate new API key, name it Cosmic Lifecycle, and select only the read scopes: customer:read, points_transaction:read, reward_fulfillment:read and vip_tier:read. Click Generate and copy the key (starts with api_); it is shown only once."
            }
        ],
        "params": [],
        "config": {
            "client": {
                "base_url": "https://api.smile.io/v1/",
                "auth": {
                    "type": "bearer",
                    "token": "{secret:api_key}"
                }
            },
            "resource_defaults": {
                "primary_key": "id",
                "write_disposition": "merge"
            },
            "resources": [
                {
                    "name": "customers",
                    "endpoint": {
                        "path": "customers",
                        "params": {
                            "limit": 250,
                            "include": "vip_status"
                        },
                        "data_selector": "customers",
                        "paginator": {
                            "type": "cursor",
                            "cursor_path": "metadata.next_cursor",
                            "cursor_param": "cursor"
                        },
                        "incremental": {
                            "start_param": "updated_at_min",
                            "cursor_path": "updated_at",
                            "initial_value": "2010-01-01T00:00:00.000Z"
                        }
                    }
                },
                {
                    "name": "points_transactions",
                    "endpoint": {
                        "path": "points_transactions",
                        "params": {
                            "limit": 250
                        },
                        "data_selector": "points_transactions",
                        "paginator": {
                            "type": "cursor",
                            "cursor_path": "metadata.next_cursor",
                            "cursor_param": "cursor"
                        },
                        "incremental": {
                            "start_param": "updated_at_min",
                            "cursor_path": "updated_at",
                            "initial_value": "2010-01-01T00:00:00.000Z"
                        }
                    }
                },
                {
                    "name": "reward_fulfillments",
                    "endpoint": {
                        "path": "reward_fulfillments",
                        "params": {
                            "limit": 250
                        },
                        "data_selector": "reward_fulfillments",
                        "paginator": {
                            "type": "cursor",
                            "cursor_path": "metadata.next_cursor",
                            "cursor_param": "cursor"
                        },
                        "incremental": {
                            "start_param": "updated_at_min",
                            "cursor_path": "updated_at",
                            "initial_value": "2010-01-01T00:00:00.000Z"
                        }
                    }
                },
                {
                    "name": "vip_tiers",
                    "write_disposition": "replace",
                    "endpoint": {
                        "path": "vip_tiers",
                        "params": {
                            "include": "perks,entry_rewards"
                        },
                        "data_selector": "vip_tiers",
                        "paginator": {
                            "type": "single_page"
                        }
                    }
                }
            ]
        },
        "notes": "API keys exist only on Plus and Enterprise plans; brands on Free or Starter cannot connect. Smile recommends a merchant API key for single-merchant integrations and an OAuth app for products reused across many merchants; this spec uses the merchant's own key, which matches a per-brand CLI but would need an app listing if Cosmic Lifecycle ever connects Smile on the merchant's behalf at scale. Cursor pagination: metadata.next_cursor passed back as cursor, limit max 250, results newest first by id. Incremental on updated_at via updated_at_min (documented on all three list endpoints; points_transactions says at-or-after, the others say after, so merge on id absorbs any overlap). customers include=vip_status adds the current tier. vip_tiers has no pagination and is replaced each run. Rate limit 10 requests per second per key. Customer names and emails are stripped by the runner's personal-data filter."
    },
    {
        "slug": "shipstation",
        "name": "ShipStation",
        "category": "shipping",
        "readiness": "built",
        "why": "#23 of 100 tools Shopify stores use. Ranking position is judgment. StoreLeads shows only 719 storefront-detected installs because it is a backend app; real usage is far higher. txtcart.ai calls it the workhorse of in-house label printing for Shopify brands. Source: https://txtcart.ai/blog/shipbob-alternatives/",
        "docs": "https://docs.shipstation.com/getting-started",
        "credentials": [
            {
                "name": "api_key",
                "label": "ShipStation V2 API key",
                "help": "In ShipStation go to Settings > Account > API Settings (ship.shipstation.com/#/settings/api); the page also shows whether your plan includes API access. Choose the V2 API key (not the legacy V1 key and secret) and click Generate API Key, then copy it; it is shown only once and only one V2 key can be active, so generating a new one replaces any existing V2 key. ShipStation keys have no scopes or read-only mode; this connector only sends GET requests."
            }
        ],
        "params": [
            {
                "name": "start_date",
                "label": "Sync history from (ISO date, UTC)",
                "example": "2026-01-01T00:00:00Z"
            }
        ],
        "config": {
            "client": {
                "base_url": "https://api.shipstation.com/v2/",
                "auth": {
                    "type": "api_key",
                    "name": "API-Key",
                    "api_key": "{secret:api_key}",
                    "location": "header"
                }
            },
            "resource_defaults": {
                "write_disposition": "merge"
            },
            "resources": [
                {
                    "name": "shipments",
                    "primary_key": "shipment_id",
                    "endpoint": {
                        "path": "shipments",
                        "params": {
                            "page_size": 500,
                            "sort_by": "modified_at",
                            "sort_dir": "asc"
                        },
                        "data_selector": "shipments",
                        "paginator": {
                            "type": "page_number",
                            "page_param": "page",
                            "base_page": 1,
                            "total_path": "pages"
                        },
                        "incremental": {
                            "start_param": "modified_at_start",
                            "cursor_path": "modified_at",
                            "initial_value": "{param:start_date}"
                        }
                    }
                },
                {
                    "name": "labels",
                    "primary_key": "label_id",
                    "endpoint": {
                        "path": "labels",
                        "params": {
                            "page_size": 500,
                            "sort_by": "created_at",
                            "sort_dir": "asc"
                        },
                        "data_selector": "labels",
                        "paginator": {
                            "type": "page_number",
                            "page_param": "page",
                            "base_page": 1,
                            "total_path": "pages"
                        },
                        "incremental": {
                            "start_param": "created_at_start",
                            "cursor_path": "created_at",
                            "initial_value": "{param:start_date}"
                        }
                    }
                }
            ]
        },
        "notes": "Uses ShipStation API V2 (api.shipstation.com/v2, API-Key header). The V1 API (ssapi.shipstation.com, Basic auth with key plus secret) is marked deprecated and slated for removal, so it is not used; V1 orders map to V2 shipments (orderId N becomes shipment_id se-N, and awaiting_payment, awaiting_shipment and on_hold all collapse to pending). V2 is still labelled early release by ShipStation. API access depends on plan. Pagination: page/page_size with a pages total in the response; page_size max 500 is documented for labels and shown as a valid example for shipments. Hard limit: list shipments rejects any offset past 10,000 rows (page x page_size) with a 400, so the first sync must start from a start_date recent enough to hold fewer than 10,000 shipments; after that the modified_at_start incremental (sorted ascending) keeps each run small. If a brand ships more than 10,000 orders between syncs, the run fails and needs a later start_date. labels only filter on created_at, so incremental is by creation; a label voided after it was synced is not re-fetched (voided_at stays stale). No sandbox for ShipStation platform keys: every call hits production, but GET calls do not cost money. Addresses and names are stripped by the runner's personal-data filter."
    },
    {
        "slug": "aftership-tracking",
        "name": "AfterShip Tracking",
        "category": "shipping",
        "readiness": "built",
        "why": "#24 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 15,168 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/aftership",
        "docs": "https://www.aftership.com/docs/tracking/quickstart/api-quick-start",
        "credentials": [
            {
                "name": "api_key",
                "label": "AfterShip API key",
                "help": "Sign in to AfterShip and open the organization API keys page (organization.automizely.com/api-keys), click Create an API key, pick the plain API key authentication type (not AES or RSA signature), name it Cosmic Lifecycle and copy the key. AfterShip does not document a read-only permission level for Tracking keys; this connector only sends GET requests."
            }
        ],
        "params": [],
        "config": {
            "client": {
                "base_url": "https://api.aftership.com/tracking/2026-07/",
                "auth": {
                    "type": "api_key",
                    "name": "as-api-key",
                    "api_key": "{secret:api_key}",
                    "location": "header"
                }
            },
            "resource_defaults": {
                "primary_key": "id",
                "write_disposition": "merge"
            },
            "resources": [
                {
                    "name": "trackings",
                    "endpoint": {
                        "path": "trackings",
                        "params": {
                            "limit": 200
                        },
                        "data_selector": "data.trackings",
                        "paginator": {
                            "type": "cursor",
                            "cursor_path": "data.pagination.next_cursor",
                            "cursor_param": "cursor"
                        },
                        "incremental": {
                            "start_param": "updated_at_min",
                            "cursor_path": "updated_at",
                            "initial_value": "2020-01-01T00:00:00+00:00"
                        }
                    }
                },
                {
                    "name": "couriers",
                    "primary_key": "slug",
                    "write_disposition": "replace",
                    "endpoint": {
                        "path": "couriers",
                        "data_selector": "data.couriers",
                        "paginator": {
                            "type": "single_page"
                        }
                    }
                }
            ]
        },
        "notes": "API version pinned to 2026-07 (current at time of writing). trackings: cursor pagination via data.pagination.next_cursor (data.pagination.has_next_page also present), limit max 200 (default 100). Incremental on updated_at via updated_at_min. created_at_min defaults to 120 days ago and AfterShip only stores 120 days of tracking data, so the first sync returns at most the last 120 days and trackings older than that age out of the API; the warehouse keeps what it already loaded. Checkpoints (carrier scan events) come nested in each tracking and dlt unpacks them into a child table trackings__checkpoints, so no separate checkpoint call is needed. couriers lists the account's activated couriers, single page, replaced each run. GET rate limit 5 requests per second. Customer names, emails and phone numbers inside customers and subscribed_* fields are stripped by the runner's personal-data filter."
    },
    {
        "slug": "microsoft-ads",
        "name": "Microsoft Advertising (Bing Ads)",
        "category": "ads",
        "readiness": "planned",
        "why": "#25 of 100 tools Shopify stores use. StoreLeads: detected on 49,268 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/technology/Bing%20Ads",
        "docs": "https://learn.microsoft.com/en-us/advertising/guides/",
        "credentials": [],
        "params": [],
        "notes": "Needs an OAuth sign-in flow, not built yet. CSV import meanwhile."
    },
    {
        "slug": "pinterest-ads",
        "name": "Pinterest Ads",
        "category": "ads",
        "readiness": "planned",
        "why": "#26 of 100 tools Shopify stores use. Ranking position is judgment. StoreLeads app page shows no install count (Pinterest app not detectable). StoreLeads: Pinterest account linked on 216,448 Shopify stores. Source: https://storeleads.app/reports/shopify",
        "docs": "https://developers.pinterest.com/docs/api/v5/",
        "credentials": [],
        "params": [],
        "notes": "Needs an OAuth sign-in flow, not built yet. CSV import meanwhile."
    },
    {
        "slug": "omnisend",
        "name": "Omnisend",
        "category": "email-sms",
        "readiness": "built",
        "why": "#27 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 65,812 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/omnisend",
        "docs": "https://api-docs.omnisend.com/reference/getting-started",
        "credentials": [
            {
                "name": "api_key",
                "label": "Omnisend API key",
                "help": "In Omnisend open Store settings > API keys (app.omnisend.com/integrations/api-keys) and click Create API key, named Cosmic Lifecycle. If the form lets you pick permissions, grant only contacts.read, campaigns.read and automations.read and leave every write permission off. Copy the key right away; Omnisend will not show it again."
            }
        ],
        "params": [],
        "config": {
            "client": {
                "base_url": "https://api.omnisend.com/api/",
                "headers": {
                    "Omnisend-Version": "2026-03-15"
                },
                "auth": {
                    "type": "api_key",
                    "name": "Authorization",
                    "api_key": "Omnisend-API-Key {secret:api_key}",
                    "location": "header"
                }
            },
            "resource_defaults": {
                "primary_key": "id",
                "write_disposition": "merge"
            },
            "resources": [
                {
                    "name": "contacts",
                    "endpoint": {
                        "path": "contacts",
                        "params": {
                            "limit": 250,
                            "sort": "updatedAt",
                            "direction": "asc"
                        },
                        "data_selector": "contacts",
                        "paginator": {
                            "type": "cursor",
                            "cursor_path": "paging.cursors.after",
                            "cursor_param": "after"
                        },
                        "incremental": {
                            "start_param": "updatedAtFrom",
                            "cursor_path": "updatedAt",
                            "initial_value": "2010-01-01T00:00:00Z"
                        }
                    }
                },
                {
                    "name": "campaigns",
                    "endpoint": {
                        "path": "campaigns",
                        "params": {
                            "limit": 250,
                            "sort": "updatedAt",
                            "direction": "asc",
                            "view": "summary"
                        },
                        "data_selector": "campaigns",
                        "paginator": {
                            "type": "cursor",
                            "cursor_path": "paging.cursors.after",
                            "cursor_param": "after"
                        },
                        "incremental": {
                            "start_param": "updatedAtFrom",
                            "cursor_path": "updatedAt",
                            "initial_value": "2010-01-01T00:00:00Z"
                        }
                    }
                },
                {
                    "name": "automations",
                    "endpoint": {
                        "path": "automations",
                        "params": {
                            "limit": 250,
                            "sort": "updatedAt",
                            "direction": "asc",
                            "view": "summary"
                        },
                        "data_selector": "automations",
                        "paginator": {
                            "type": "cursor",
                            "cursor_path": "paging.cursors.after",
                            "cursor_param": "after"
                        },
                        "incremental": {
                            "start_param": "updatedAtFrom",
                            "cursor_path": "updatedAt",
                            "initial_value": "2010-01-01T00:00:00Z"
                        }
                    }
                }
            ]
        },
        "notes": "Targets the dated API version 2026-03-15 (base https://api.omnisend.com/api, Authorization: Omnisend-API-Key <key>, plus the required Omnisend-Version header). The older v3 and v5 APIs are superseded per Omnisend's migration guides. All three lists use cursor pagination: paging.cursors.after sent back as after, limit max 250; Omnisend accepts the original filters alongside the cursor. Incremental on updatedAt via updatedAtFrom, sorted ascending; on contacts updatedAtFrom cannot be combined with status, tag, segmentID, email or phone, so none of those are sent. campaigns and automations use view=summary to skip email content and automation block trees. Campaign and automation performance numbers (sends, opens, clicks, revenue) are not on these objects; they live only in POST /analytics/reports and /analytics/statistics, which are read-only report endpoints but are limited to 10 per minute and 55 per 24 hours per brand and need a request body, so they are left out of this spec. Campaign and Automation schemas are labelled 2026-preview in the reference. Contact emails and phones (inside identifiers) are stripped by the runner's personal-data filter. Rate limit 400 requests per minute per brand, shared with every other integration on the account. The per-endpoint scopes (contacts.read, campaigns.read, automations.read) are documented, but the docs do not show whether the API key form lets a merchant restrict a key to them; unverified."
    },
    {
        "slug": "microsoft-clarity",
        "name": "Microsoft Clarity",
        "category": "analytics",
        "readiness": "planned",
        "why": "#28 of 100 tools Shopify stores use. StoreLeads: detected on 210,181 Shopify stores (Oct 30 2026 snapshot). Alium: about one in eleven Shopify stacks, often replacing Hotjar. Source: https://storeleads.app/reports/technology/Microsoft%20Clarity",
        "docs": "https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "zendesk",
        "name": "Zendesk",
        "category": "helpdesk",
        "readiness": "built",
        "why": "#29 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 16,005 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/zendesk",
        "docs": "https://developer.zendesk.com/api-reference/",
        "credentials": [
            {
                "name": "api_token",
                "label": "API token",
                "help": "Zendesk Admin Center, Apps and integrations, APIs, Zendesk API (Settings tab): turn on Token access, click Add API token, copy it once. Zendesk API tokens are not scopable and act as the admin who owns the email you enter, so use an admin account dedicated to reporting. The incremental ticket export and satisfaction ratings endpoints are Admin only."
            }
        ],
        "params": [
            {
                "name": "subdomain",
                "label": "Zendesk subdomain (the part before .zendesk.com)",
                "example": "acmecoffee"
            },
            {
                "name": "email",
                "label": "Email of the admin who owns the API token",
                "example": "reporting@acmecoffee.com"
            }
        ],
        "config": {
            "client": {
                "base_url": "https://{param:subdomain}.zendesk.com/api/v2/",
                "auth": {
                    "type": "http_basic",
                    "username": "{param:email}/token",
                    "password": "{secret:api_token}"
                }
            },
            "resource_defaults": {
                "primary_key": "id",
                "write_disposition": "merge"
            },
            "resources": [
                {
                    "name": "tickets",
                    "endpoint": {
                        "path": "incremental/tickets/cursor",
                        "data_selector": "tickets",
                        "params": {
                            "per_page": 1000,
                            "start_time": {
                                "type": "incremental",
                                "cursor_path": "generated_timestamp",
                                "initial_value": 1262304000
                            }
                        },
                        "paginator": {
                            "type": "cursor",
                            "cursor_path": "after_cursor",
                            "cursor_param": "cursor",
                            "stop_after_empty_page": true
                        }
                    }
                },
                {
                    "name": "users",
                    "endpoint": {
                        "path": "incremental/users/cursor",
                        "data_selector": "users",
                        "params": {
                            "per_page": 1000,
                            "start_time": 1262304000
                        },
                        "paginator": {
                            "type": "cursor",
                            "cursor_path": "after_cursor",
                            "cursor_param": "cursor",
                            "stop_after_empty_page": true
                        }
                    }
                },
                {
                    "name": "satisfaction_ratings",
                    "endpoint": {
                        "path": "satisfaction_ratings",
                        "data_selector": "satisfaction_ratings",
                        "params": {
                            "page[size]": 100
                        },
                        "paginator": {
                            "type": "cursor",
                            "cursor_path": "meta.after_cursor",
                            "cursor_param": "page[after]",
                            "has_more_path": "meta.has_more"
                        }
                    }
                },
                {
                    "name": "ticket_metrics",
                    "endpoint": {
                        "path": "ticket_metrics",
                        "data_selector": "ticket_metrics",
                        "params": {
                            "page[size]": 100
                        },
                        "paginator": {
                            "type": "cursor",
                            "cursor_path": "meta.after_cursor",
                            "cursor_param": "page[after]",
                            "has_more_path": "meta.has_more"
                        }
                    }
                }
            ]
        },
        "notes": "Tickets and users use the cursor-based incremental exports (per_page max 1000, docs default 1000). The response gives after_cursor and end_of_stream; after_cursor stays non-null at end of stream because Zendesk wants it reused for the next export, so the paginator stops on the first empty page (stop_after_empty_page) rather than on a null cursor. That costs one extra request per sync. dlt's has_more_path cannot invert end_of_stream, which is why it is not used. Tickets incremental maps dlt's last generated_timestamp (unix seconds, present on every exported ticket) onto start_time; dlt resends start_time alongside cursor on later pages, and the docs say start_time is only used on the initial request, so I expect Zendesk to ignore it there, but that is not explicitly documented. Initial value 1262304000 = 2010-01-01; docs say the initial start_time is arbitrary but must be over one minute in the past. Users are a full cursor export each run (no generated_timestamp-based incremental wired, the users export has no such documented field) and most user fields are personal and get stripped. satisfaction_ratings and ticket_metrics use standard Zendesk cursor pagination: page[size] max 100, meta.after_cursor, meta.has_more. Rate limit on incremental exports: 10 requests per minute (users cursor: 20). Skipped: ticket_events and ticket_metric_events, because they are time-based exports whose next_page URL is not documented to become null at the end, so a json_link paginator could loop. Satisfaction ratings require CSAT to be enabled on the account."
    },
    {
        "slug": "xero",
        "name": "Xero",
        "category": "accounting",
        "readiness": "planned",
        "why": "#30 of 100 tools Shopify stores use. Ranking position is judgment. No public Shopify count found (backend app). A2X markets Shopify-to-Xero sync; Xero is the common ledger outside the US. Source: https://www.a2xaccounting.com/",
        "docs": "https://developer.xero.com/documentation/api/accounting/overview",
        "credentials": [],
        "params": [],
        "notes": "Needs an OAuth sign-in flow, not built yet. CSV import meanwhile."
    },
    {
        "slug": "shipbob",
        "name": "ShipBob",
        "category": "shipping",
        "readiness": "built",
        "why": "#31 of 100 tools Shopify stores use. Ranking position is judgment. No install count (backend). Flow.space: one of the most visible fulfillment names in the Shopify ecosystem. Source: https://flow.space/blog/best-3pl-for-shopify",
        "docs": "https://developer.shipbob.com/2026-07/",
        "credentials": [
            {
                "name": "pat",
                "label": "Personal Access Token",
                "help": "Sign in to the ShipBob dashboard as the account root user, go to Integrations, API Tokens (https://web.shipbob.com/app/merchant/#/Integrations/token-management) and click Generate New Token. A PAT does not expire; revoke it there when you disconnect. ShipBob PATs are not scope-selectable in the UI: the auto-created PAT channel carries read scopes (orders_read, inventory_read, returns_read, billing_read and others) plus write scopes, and this connector only uses GET requests."
            }
        ],
        "params": [],
        "config": {
            "client": {
                "base_url": "https://api.shipbob.com/2026-07/",
                "auth": {
                    "type": "bearer",
                    "token": "{secret:pat}"
                }
            },
            "resource_defaults": {
                "primary_key": "id",
                "write_disposition": "merge"
            },
            "resources": [
                {
                    "name": "orders",
                    "endpoint": {
                        "path": "order",
                        "params": {
                            "Limit": 250,
                            "SortOrder": "Oldest"
                        },
                        "data_selector": "$",
                        "paginator": {
                            "type": "page_number",
                            "page_param": "Page",
                            "base_page": 1,
                            "total_path": null
                        }
                    }
                },
                {
                    "name": "inventory_levels",
                    "primary_key": "inventory_id",
                    "endpoint": {
                        "path": "inventory-level",
                        "params": {
                            "PageSize": 100
                        },
                        "data_selector": "items",
                        "paginator": {
                            "type": "json_link",
                            "next_url_path": "next"
                        }
                    }
                },
                {
                    "name": "returns",
                    "endpoint": {
                        "path": "return",
                        "params": {
                            "Limit": 100,
                            "SortOrder": "Asc"
                        },
                        "data_selector": "items",
                        "paginator": {
                            "type": "json_link",
                            "next_url_path": "next"
                        }
                    }
                },
                {
                    "name": "invoices",
                    "primary_key": "invoice_id",
                    "endpoint": {
                        "path": "invoices",
                        "params": {
                            "PageSize": 100,
                            "FromDate": "2015-01-01T00:00:00Z",
                            "SortOrder": "Ascending"
                        },
                        "data_selector": "items",
                        "paginator": {
                            "type": "cursor",
                            "cursor_path": "next",
                            "cursor_param": "Cursor"
                        }
                    }
                }
            ]
        },
        "notes": "API version 2026-07 (current default). All GET. orders: response body is a bare array; pagination is Page/Limit with total-pages and total-count returned only as response headers, so the page_number paginator runs until an empty page (total_path null). Limit 250 comes from the docs' recommended request; no maximum is stated. Orders embed shipments (with tracking and last_update_at), so shipments are not a separate resource. inventory_levels and returns: body has items plus next, documented as a URL to the next page (json_link). Page size maxima are not documented for these; 100 is used as the safe value. invoices: next is a cursor token passed back as Cursor (the example shows a token, not a URL); the reference says PageSize 1 to 1000 but the billing guide says max 100, so 100 is used. FromDate defaults to one month ago, so it is pinned to 2015-01-01 to backfill. No incremental: the orders LastUpdateStartDate filter exists but the order record carries no updated timestamp to use as a cursor, and returns/invoices only filter on created/invoice date, so all resources are full refresh merged on primary key. Orders full refresh can be slow on high-volume accounts. Sandbox host is https://sandbox-api.shipbob.com if needed."
    },
    {
        "slug": "route",
        "name": "Route",
        "category": "shipping",
        "readiness": "planned",
        "why": "#32 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 11,331 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/route",
        "docs": "",
        "credentials": [],
        "params": [],
        "notes": "API is partner-only or needs vendor approval. CSV import meanwhile."
    },
    {
        "slug": "privy",
        "name": "Privy",
        "category": "email-sms",
        "readiness": "planned",
        "why": "#33 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 43,495 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/privy",
        "docs": "",
        "credentials": [],
        "params": [],
        "notes": "API is partner-only or needs vendor approval. CSV import meanwhile."
    },
    {
        "slug": "mailchimp",
        "name": "Mailchimp",
        "category": "email-sms",
        "readiness": "built",
        "why": "#34 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 141,673 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/mailchimp",
        "docs": "https://mailchimp.com/developer/marketing/api/",
        "credentials": [
            {
                "name": "api_key",
                "label": "API key",
                "help": "Sign in to Mailchimp and open the API Keys section of your account (https://us1.admin.mailchimp.com/account/api/, it redirects to your own data center), then click Create A Key. Mailchimp keys cannot be scoped or made read-only: every key has full account access, so create it from a dedicated admin user and delete it when you disconnect. This connector only sends GET requests. The key ends in a data center suffix such as -us21; enter the part after the dash (us21) as the Data center setting."
            }
        ],
        "params": [
            {
                "name": "dc",
                "label": "Data center (the suffix after the dash in your API key, e.g. us21)",
                "example": "us21"
            }
        ],
        "config": {
            "client": {
                "base_url": "https://{param:dc}.api.mailchimp.com/3.0/",
                "auth": {
                    "type": "bearer",
                    "token": "{secret:api_key}"
                },
                "paginator": {
                    "type": "offset",
                    "limit": 1000,
                    "offset": 0,
                    "offset_param": "offset",
                    "limit_param": "count",
                    "total_path": "total_items"
                }
            },
            "resource_defaults": {
                "primary_key": "id",
                "write_disposition": "merge"
            },
            "resources": [
                {
                    "name": "campaigns",
                    "endpoint": {
                        "path": "campaigns",
                        "data_selector": "campaigns"
                    }
                },
                {
                    "name": "campaign_reports",
                    "endpoint": {
                        "path": "reports",
                        "data_selector": "reports"
                    }
                },
                {
                    "name": "lists",
                    "endpoint": {
                        "path": "lists",
                        "data_selector": "lists"
                    }
                },
                {
                    "name": "automations",
                    "endpoint": {
                        "path": "automations",
                        "data_selector": "automations"
                    }
                },
                {
                    "name": "ecommerce_orders",
                    "primary_key": [
                        "store_id",
                        "id"
                    ],
                    "endpoint": {
                        "path": "ecommerce/orders",
                        "data_selector": "orders"
                    }
                }
            ]
        },
        "notes": "All GET. Pagination is offset/count with count max 1000 and total_items in the body (methods-and-parameters page). Auth: docs accept the key as a Bearer token or as the HTTP Basic password; bearer is used. Base URL: the current (Fern) docs show the root as https://api.mailchimp.com/3.0/ with no data center; the long-standing data-center host https://<dc>.api.mailchimp.com/3.0/ is used here as requested and has always routed correctly for keys from that dc. If the unprefixed host is confirmed to work for API keys, dc could be dropped. No incremental: the only time filters are send/create time (campaigns, reports, automations) or list creation date, while report stats and order status keep changing after creation, so every resource is a full refresh merged on primary key. ecommerce_orders: order id is only unique within a store, so the key is [store_id, id]; it only returns data if a store (e.g. the Shopify integration) syncs orders to Mailchimp. Mailchimp keys cannot be made read-only; the connector itself only issues GETs. 120 second request timeout applies; count=1000 on reports may be slow on large accounts."
    },
    {
        "slug": "stamped",
        "name": "Stamped (Loyalty 2.0 and merchant records)",
        "category": "reviews",
        "readiness": "built",
        "why": "#35 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 31,397 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/product-reviews-addon",
        "docs": "https://developers.stamped.io/docs/getting-started",
        "credentials": [
            {
                "name": "api_key",
                "label": "Private API key",
                "help": "Stamped dashboard, Settings, Loyalty Integrations (or Review Integrations), API Keys: click + Add API Key and copy it. Only the account owner can generate keys. Stamped keys have no read-only scope; the key can also adjust points, so store it as a secret and use it only for this connector. The API requires a Professional or Enterprise plan."
            }
        ],
        "params": [
            {
                "name": "shop_id",
                "label": "Shop ID (Store Hash), shown in the same API Keys screen",
                "example": "123456"
            }
        ],
        "config": {
            "client": {
                "base_url": "https://stamped.io/api/v3/",
                "auth": {
                    "type": "api_key",
                    "name": "stamped-api-key",
                    "api_key": "{secret:api_key}",
                    "location": "header"
                },
                "paginator": {
                    "type": "page_number",
                    "base_page": 0,
                    "page_param": "page",
                    "total_path": null,
                    "has_more_path": "morePages"
                }
            },
            "resource_defaults": {
                "write_disposition": "merge"
            },
            "resources": [
                {
                    "name": "loyalty_activities",
                    "primary_key": "activityId",
                    "endpoint": {
                        "path": "loyalty/shops/{param:shop_id}/activities",
                        "data_selector": "activities",
                        "params": {
                            "limit": 25
                        }
                    }
                },
                {
                    "name": "loyalty_rewards",
                    "primary_key": "rewardId",
                    "endpoint": {
                        "path": "loyalty/shops/{param:shop_id}/rewards",
                        "data_selector": "rewards",
                        "params": {
                            "limit": 25
                        }
                    }
                },
                {
                    "name": "customers",
                    "primary_key": "customerId",
                    "endpoint": {
                        "path": "merchant/shops/{param:shop_id}/customers",
                        "data_selector": "customers",
                        "params": {
                            "limit": 25
                        }
                    }
                }
            ]
        },
        "notes": "REVIEWS ARE NOT INCLUDED. Stamped's only review list endpoint is the legacy V2 GET /api/v2/{storeHash}/dashboard/reviews (basic auth, public key / private key). Its official reference documents no pagination parameters and no response shape (it even marks an email query param as required), and the V3 Reviews API is announced as coming soon. I would have had to guess page/limit names and the results path, so I left reviews out rather than fake them. This spec covers the V3 API, which per Stamped only works for merchants on the Loyalty 2.0 dashboard (Loyalty 1.0 shops must use V2 and will get errors here). Auth is the stamped-api-key header. Pagination: page (default 0, so base_page 0) and limit (default 25); responses carry page, limit, morePages and the record array; the paginator stops when morePages is false. The documented max limit is not stated, so limit stays at the documented default 25 (safe but slow; raise it after testing). The customers endpoint lists page/limit/morePages in its response schema but not in its query parameters, so paging it by page/limit is an inference from the shared Paginated* shape. No updated-since filter is documented for activities or rewards (only customers has datePlatformCreated ranges, which track creation, not updates), so all three resources are full refresh with merge on their ids. Customer records are mostly personal fields and get stripped."
    },
    {
        "slug": "yotpo-loyalty",
        "name": "Yotpo Loyalty",
        "category": "loyalty",
        "readiness": "planned",
        "why": "#36 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 11,688 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/swell",
        "docs": "https://loyaltyapi.yotpo.com/reference",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "elevar",
        "name": "Elevar",
        "category": "analytics",
        "readiness": "planned",
        "why": "#37 of 100 tools Shopify stores use. StoreLeads: detected on 10,131 Shopify stores (Oct 30 2026 snapshot). Alium: almost only in Shopify stacks. Source: https://storeleads.app/reports/technology/Elevar",
        "docs": "",
        "credentials": [],
        "params": [],
        "notes": "No public data API. Bring daily totals in with lifecycle sources import."
    },
    {
        "slug": "tidio",
        "name": "Tidio",
        "category": "helpdesk",
        "readiness": "planned",
        "why": "#38 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 26,973 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/tidio-chat",
        "docs": "https://developers.tidio.com/",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "appstle-subscriptions",
        "name": "Appstle Subscriptions",
        "category": "subscriptions",
        "readiness": "planned",
        "why": "#39 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 34,051 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/subscriptions-by-appstle",
        "docs": "https://developers.appstle.com/",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "seal-subscriptions",
        "name": "Seal Subscriptions",
        "category": "subscriptions",
        "readiness": "planned",
        "why": "#40 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 33,941 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/seal-subscriptions",
        "docs": "https://www.sealsubscriptions.com/articles/merchant-api-documentation",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "skio",
        "name": "Skio",
        "category": "subscriptions",
        "readiness": "built",
        "why": "#41 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 1,717 Shopify stores (Oct 30 2026 snapshot). Concentrated in larger DTC brands; now a Recharge company. Source: https://storeleads.app/reports/shopify/app/skio",
        "docs": "https://code.skio.com/",
        "credentials": [
            {
                "name": "api_token",
                "label": "API token",
                "help": "Skio dashboard, click API in the left navigation, name the token and click Generate, then copy it (Skio shows it only once). Skio tokens have no read-only scope and can also run mutations, so keep it server side and use it only for this connector. A token only sees its own store, so no store ID is needed."
            }
        ],
        "params": [],
        "config": {
            "client": {
                "base_url": "https://graphql.skio.com/",
                "auth": {
                    "type": "api_key",
                    "name": "Authorization",
                    "api_key": "API {secret:api_token}",
                    "location": "header"
                }
            },
            "resource_defaults": {
                "primary_key": "id",
                "write_disposition": "merge"
            },
            "resources": [
                {
                    "name": "subscriptions",
                    "endpoint": {
                        "path": "v1/graphql",
                        "method": "POST",
                        "data_selector": "data.Subscriptions",
                        "json": {
                            "query": "query Sync($since: timestamptz!, $offset: Int!, $limit: Int!) {{ Subscriptions(where: {{updatedAt: {{_gte: $since}}}}, order_by: [{{updatedAt: asc}}, {{id: asc}}], limit: $limit, offset: $offset) {{ billingPolicyId cancelledAt churnPredictedAt churnRiskReasons churnScore createdAt currencyCode customAttributes cyclesCompleted deliveryPolicyId deliveryPrice deliveryPriceOverride id isPickup lastBillingAttemptAt maxStreakCount metadata nextBillingDate nextRenewalDate originOrderId platformId prepaidDeliveryPolicyId remainingCyclesUntilRenewal siteId status statusContext storefrontUserId streakCount streakExpiresAt updatedAt }} }}",
                            "variables": {
                                "since": "{incremental.start_value}",
                                "offset": 0,
                                "limit": 100
                            }
                        },
                        "incremental": {
                            "cursor_path": "updatedAt",
                            "initial_value": "2015-01-01T00:00:00Z"
                        },
                        "paginator": {
                            "type": "offset",
                            "limit": 100,
                            "offset_body_path": "variables.offset",
                            "limit_body_path": "variables.limit",
                            "total_path": null,
                            "stop_after_empty_page": true
                        }
                    }
                },
                {
                    "name": "subscription_lines",
                    "endpoint": {
                        "path": "v1/graphql",
                        "method": "POST",
                        "data_selector": "data.SubscriptionLines",
                        "json": {
                            "query": "query Sync($since: timestamptz!, $offset: Int!, $limit: Int!) {{ SubscriptionLines(where: {{updatedAt: {{_gte: $since}}}}, order_by: [{{updatedAt: asc}}, {{id: asc}}], limit: $limit, offset: $offset) {{ createdAt customAttributes groupId id isPrepaid ordersRemaining platformId prepaidSubscriptionId priceWithoutDiscount productVariantId quantity removedAt sellingPlanId subscriptionId taxable titleOverride updatedAt }} }}",
                            "variables": {
                                "since": "{incremental.start_value}",
                                "offset": 0,
                                "limit": 100
                            }
                        },
                        "incremental": {
                            "cursor_path": "updatedAt",
                            "initial_value": "2015-01-01T00:00:00Z"
                        },
                        "paginator": {
                            "type": "offset",
                            "limit": 100,
                            "offset_body_path": "variables.offset",
                            "limit_body_path": "variables.limit",
                            "total_path": null,
                            "stop_after_empty_page": true
                        }
                    }
                },
                {
                    "name": "orders",
                    "endpoint": {
                        "path": "v1/graphql",
                        "method": "POST",
                        "data_selector": "data.Orders",
                        "json": {
                            "query": "query Sync($since: timestamp!, $offset: Int!, $limit: Int!) {{ Orders(where: {{updatedAt: {{_gte: $since}}}}, order_by: [{{updatedAt: asc}}, {{id: asc}}], limit: $limit, offset: $offset) {{ appId cancelledAt createdAt currencyCode deletedAt deliveredAt firstOrderInPrepaidSequence fulfillAt fulfillmentOrderCredit id platformId platformNumber prepaidSubscriptionId processedAt siteId storefrontUserId subscriptionId taxExempt taxesIncluded totalPrice totalPricePresentmentAmount updatedAt }} }}",
                            "variables": {
                                "since": "{incremental.start_value}",
                                "offset": 0,
                                "limit": 100
                            }
                        },
                        "incremental": {
                            "cursor_path": "updatedAt",
                            "initial_value": "2015-01-01T00:00:00Z"
                        },
                        "paginator": {
                            "type": "offset",
                            "limit": 100,
                            "offset_body_path": "variables.offset",
                            "limit_body_path": "variables.limit",
                            "total_path": null,
                            "stop_after_empty_page": true
                        }
                    }
                },
                {
                    "name": "order_line_items",
                    "endpoint": {
                        "path": "v1/graphql",
                        "method": "POST",
                        "data_selector": "data.OrderLineItems",
                        "json": {
                            "query": "query Sync($since: timestamptz!, $offset: Int!, $limit: Int!) {{ OrderLineItems(where: {{updatedAt: {{_gte: $since}}}}, order_by: [{{updatedAt: asc}}, {{id: asc}}], limit: $limit, offset: $offset) {{ attributionGroupId createdAt currencyCode customAttributes groupId id orderId platformId pricePresentmentAmount pricePresentmentCurrencyCode priceWithoutDiscount productVariantId quantity subscriptionLineId updatedAt }} }}",
                            "variables": {
                                "since": "{incremental.start_value}",
                                "offset": 0,
                                "limit": 100
                            }
                        },
                        "incremental": {
                            "cursor_path": "updatedAt",
                            "initial_value": "2015-01-01T00:00:00Z"
                        },
                        "paginator": {
                            "type": "offset",
                            "limit": 100,
                            "offset_body_path": "variables.offset",
                            "limit_body_path": "variables.limit",
                            "total_path": null,
                            "stop_after_empty_page": true
                        }
                    }
                },
                {
                    "name": "customers",
                    "endpoint": {
                        "path": "v1/graphql",
                        "method": "POST",
                        "data_selector": "data.StorefrontUsers",
                        "json": {
                            "query": "query Sync($since: timestamptz!, $offset: Int!, $limit: Int!) {{ StorefrontUsers(where: {{updatedAt: {{_gte: $since}}}}, order_by: [{{updatedAt: asc}}, {{id: asc}}], limit: $limit, offset: $offset) {{ createdAt id platformId redactedAt removedAt shopifyTags siteId smsTransactionalOptIn updatedAt }} }}",
                            "variables": {
                                "since": "{incremental.start_value}",
                                "offset": 0,
                                "limit": 100
                            }
                        },
                        "incremental": {
                            "cursor_path": "updatedAt",
                            "initial_value": "2015-01-01T00:00:00Z"
                        },
                        "paginator": {
                            "type": "offset",
                            "limit": 100,
                            "offset_body_path": "variables.offset",
                            "limit_body_path": "variables.limit",
                            "total_path": null,
                            "stop_after_empty_page": true
                        }
                    }
                }
            ]
        },
        "notes": "Skio is GraphQL only: every call is a POST to https://graphql.skio.com/v1/graphql. All five resources send GraphQL queries only (no mutations), so the POSTs are read-only. dlt rest_api expresses this cleanly: a fixed query in the JSON body, limit/offset written into variables.offset and variables.limit by the offset paginator (offset_body_path / limit_body_path), and the dlt incremental start value written into variables.since. Braces in the query strings are doubled because dlt runs str.format over the JSON body; I confirmed against a local mock server (not Skio) that dlt 1.32.0 sends single braces, pages by offset, and passes the last updatedAt as since on the next run. Pagination follows the docs: limit + offset with a stable order_by (updatedAt asc, id asc), stop when a page is short; dlt stops on the first empty page, so one extra request per resource. Skio documents no max limit; 100 matches its own sync example. Incremental uses the documented updatedAt _gte filter. Order.updatedAt is typed timestamp (no zone) while the others are timestamptz, so the Orders query declares $since as timestamp; the docs do not say which zone a bare timestamp is in. Limits: 30,000 requests per minute per store, 100 fields and depth 4 per query; every query here is flat scalars under 40 fields. Caveat: Skio returns most errors as HTTP 200 with an errors array, which dlt does not treat as a failure, so a bad token or schema change would look like an empty sync rather than an error. Personal fields (email, names, phone) were left out of customers on purpose; nested objects (Address, PaymentMethod, Discounts) were not pulled."
    },
    {
        "slug": "northbeam",
        "name": "Northbeam",
        "category": "analytics",
        "readiness": "planned",
        "why": "#42 of 100 tools Shopify stores use. StoreLeads: detected on 1,726 Shopify stores (Oct 30 2026 snapshot). Taylor Sicard: default attribution layer for heavier paid spenders at $5M-$20M; 1Digital lists it in the 7-figure stack. Source: https://storeleads.app/reports/technology/Northbeam",
        "docs": "https://docs.northbeam.io/",
        "credentials": [],
        "params": [],
        "notes": "Attribution data only comes through an export to your own cloud bucket, which needs a custom export job. Planned."
    },
    {
        "slug": "netsuite",
        "name": "NetSuite",
        "category": "ops-erp",
        "readiness": "planned",
        "why": "#43 of 100 tools Shopify stores use. Ranking position is judgment. Alium: about 3x more common at Shopify brands than elsewhere, usually connected via Celigo middleware. Mostly brands above $5M. Source: https://www.alium.io/research/shopify-dtc-stack",
        "docs": "https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_1540391670.html",
        "credentials": [],
        "params": [],
        "notes": "Needs an OAuth sign-in flow, not built yet. CSV import meanwhile."
    },
    {
        "slug": "refersion",
        "name": "Refersion",
        "category": "affiliate",
        "readiness": "planned",
        "why": "#44 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 4,056 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/refersion",
        "docs": "https://www.refersion.dev/",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "goaffpro",
        "name": "GoAffPro",
        "category": "affiliate",
        "readiness": "planned",
        "why": "#45 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 50,401 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/goaffpro",
        "docs": "https://api.goaffpro.com/docs/admin/",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "fairing",
        "name": "Fairing",
        "category": "surveys",
        "readiness": "planned",
        "why": "#46 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 3,389 Shopify stores (Oct 30 2026 snapshot). Taylor Sicard lists it for $5M-$20M brands. Source: https://storeleads.app/reports/shopify/app/fairing",
        "docs": "https://docs.fairing.co/",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "knocommerce",
        "name": "KnoCommerce",
        "category": "surveys",
        "readiness": "planned",
        "why": "#47 of 100 tools Shopify stores use. Ranking position is judgment. No StoreLeads page found. Main Fairing competitor in DTC post-purchase surveys. Source: https://storeleads.app/reports/shopify/app/kno-commerce",
        "docs": "https://developers.knocommerce.com/",
        "credentials": [],
        "params": [],
        "notes": "Needs an OAuth sign-in flow, not built yet. CSV import meanwhile."
    },
    {
        "slug": "intelligems",
        "name": "Intelligems",
        "category": "upsell-cro",
        "readiness": "planned",
        "why": "#48 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 7,296 Shopify stores (Oct 30 2026 snapshot). Alium: Shopify-only, chosen for being built for Shopify. Source: https://storeleads.app/reports/shopify/app/intelligems",
        "docs": "",
        "credentials": [],
        "params": [],
        "notes": "API is partner-only or needs vendor approval. CSV import meanwhile."
    },
    {
        "slug": "sezzle",
        "name": "Sezzle",
        "category": "payments",
        "readiness": "planned",
        "why": "#49 of 100 tools Shopify stores use. StoreLeads: detected on 35,233 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/technology/Sezzle",
        "docs": "https://docs.sezzle.com/",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "affirm",
        "name": "Affirm",
        "category": "payments",
        "readiness": "planned",
        "why": "#50 of 100 tools Shopify stores use. StoreLeads: detected on 11,850 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/technology/Affirm",
        "docs": "https://docs.affirm.com/developers/reference",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "boost-search",
        "name": "Boost AI Search & Filter",
        "category": "search",
        "readiness": "planned",
        "why": "#52 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 19,887 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/product-filter-search",
        "docs": "",
        "credentials": [],
        "params": [],
        "notes": "API is partner-only or needs vendor approval. CSV import meanwhile."
    },
    {
        "slug": "searchanise",
        "name": "Searchanise",
        "category": "search",
        "readiness": "planned",
        "why": "#53 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 12,708 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/searchanise",
        "docs": "",
        "credentials": [],
        "params": [],
        "notes": "No public data API. Bring daily totals in with lifecycle sources import."
    },
    {
        "slug": "searchspring",
        "name": "Searchspring",
        "category": "search",
        "readiness": "planned",
        "why": "#54 of 100 tools Shopify stores use. StoreLeads: detected on 1,142 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/technology/Searchspring",
        "docs": "https://docs.searchspring.com/",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "nosto",
        "name": "Nosto",
        "category": "search",
        "readiness": "planned",
        "why": "#55 of 100 tools Shopify stores use. StoreLeads: detected on 2,057 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/technology/Nosto",
        "docs": "https://docs.nosto.com/techdocs/apis/graphql-an-introduction",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "aftership-returns",
        "name": "AfterShip Returns",
        "category": "returns",
        "readiness": "planned",
        "why": "#56 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 4,949 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/returns-center-by-aftership",
        "docs": "https://www.aftership.com/docs/returns",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "avalara",
        "name": "Avalara AvaTax",
        "category": "tax",
        "readiness": "planned",
        "why": "#57 of 100 tools Shopify stores use. Ranking position is judgment. No install count (backend). Taylor Sicard lists Avalara in the $5M-$20M stack. Source: https://taylorsicard.com/blog/shopify-tech-stack-by-revenue",
        "docs": "https://developer.avalara.com/api-reference/avatax/rest/v2/",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "amazon-ads",
        "name": "Amazon Ads",
        "category": "ads",
        "readiness": "planned",
        "why": "#58 of 100 tools Shopify stores use. Ranking position is judgment. No Shopify-specific count. Paired with Amazon Seller Central for multichannel DTC brands. Source: https://advertising.amazon.com/API/docs/en-us",
        "docs": "https://advertising.amazon.com/API/docs/en-us",
        "credentials": [],
        "params": [],
        "notes": "Needs an OAuth sign-in flow, not built yet. CSV import meanwhile."
    },
    {
        "slug": "google-merchant-center",
        "name": "Google Merchant Center",
        "category": "product-feeds",
        "readiness": "planned",
        "why": "#59 of 100 tools Shopify stores use. Ranking position is judgment. No count. Required for Shopping ads, which run on the Google Ads base (1.12M Shopify stores with Google Ads Pixel per StoreLeads). Source: https://storeleads.app/reports/shopify",
        "docs": "https://developers.google.com/merchant/api",
        "credentials": [],
        "params": [],
        "notes": "Needs an OAuth sign-in flow, not built yet. CSV import meanwhile."
    },
    {
        "slug": "aftersell",
        "name": "AfterSell",
        "category": "upsell-cro",
        "readiness": "planned",
        "why": "#60 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 13,117 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/aftersell",
        "docs": "",
        "credentials": [],
        "params": [],
        "notes": "No public data API. Bring daily totals in with lifecycle sources import."
    },
    {
        "slug": "reconvert",
        "name": "ReConvert",
        "category": "upsell-cro",
        "readiness": "planned",
        "why": "#61 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 9,792 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/reconvert-upsell-cross-sell",
        "docs": "",
        "credentials": [],
        "params": [],
        "notes": "No public data API. Bring daily totals in with lifecycle sources import."
    },
    {
        "slug": "zipify-ocu",
        "name": "Zipify One Click Upsell",
        "category": "upsell-cro",
        "readiness": "planned",
        "why": "#62 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 9,927 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/zipify-oneclickupsell",
        "docs": "",
        "credentials": [],
        "params": [],
        "notes": "No public data API. Bring daily totals in with lifecycle sources import."
    },
    {
        "slug": "loyaltylion",
        "name": "LoyaltyLion",
        "category": "loyalty",
        "readiness": "built",
        "why": "#63 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 6,243 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/loyaltylion",
        "docs": "https://developers.loyaltylion.com/api-reference/introduction",
        "credentials": [
            {
                "name": "api_key",
                "label": "API key",
                "help": "LoyaltyLion admin, Manage, API keys, Create API key. Tick only the read scopes read_customers (customers, points, tiers, activities, transactions) and read_orders. Copy the token right away; it is shown once."
            }
        ],
        "params": [],
        "config": {
            "client": {
                "base_url": "https://api.loyaltylion.com/v2/",
                "auth": {
                    "type": "bearer",
                    "token": "{secret:api_key}"
                }
            },
            "resource_defaults": {
                "primary_key": "id",
                "write_disposition": "merge"
            },
            "resources": [
                {
                    "name": "customers",
                    "endpoint": {
                        "path": "customers",
                        "data_selector": "customers",
                        "params": {
                            "limit": 500,
                            "updated_at_min": {
                                "type": "incremental",
                                "cursor_path": "updated_at",
                                "initial_value": "2015-01-01T00:00:00Z"
                            }
                        },
                        "paginator": {
                            "type": "cursor",
                            "cursor_path": "cursor.next",
                            "cursor_param": "cursor"
                        }
                    }
                },
                {
                    "name": "orders",
                    "endpoint": {
                        "path": "orders",
                        "data_selector": "orders",
                        "params": {
                            "limit": 500,
                            "updated_at_min": {
                                "type": "incremental",
                                "cursor_path": "updated_at",
                                "initial_value": "2015-01-01T00:00:00Z"
                            }
                        },
                        "paginator": {
                            "type": "cursor",
                            "cursor_path": "cursor.next",
                            "cursor_param": "cursor"
                        }
                    }
                },
                {
                    "name": "activities",
                    "endpoint": {
                        "path": "activities",
                        "data_selector": "activities",
                        "params": {
                            "limit": 500,
                            "created_at_min": {
                                "type": "incremental",
                                "cursor_path": "created_at",
                                "initial_value": "2015-01-01T00:00:00Z"
                            }
                        },
                        "paginator": {
                            "type": "cursor",
                            "cursor_path": "cursor.next",
                            "cursor_param": "cursor"
                        }
                    }
                },
                {
                    "name": "transactions",
                    "endpoint": {
                        "path": "transactions",
                        "data_selector": "transactions",
                        "params": {
                            "limit": 500,
                            "created_at_min": {
                                "type": "incremental",
                                "cursor_path": "created_at",
                                "initial_value": "2015-01-01T00:00:00Z"
                            }
                        },
                        "paginator": {
                            "type": "cursor",
                            "cursor_path": "cursor.next",
                            "cursor_param": "cursor"
                        }
                    }
                }
            ]
        },
        "notes": "Bearer API key with read_customers and read_orders scopes only (read_orders is separate; customers scope does not include orders). Pagination is LoyaltyLion's documented cursor scheme: response.cursor.next, passed back as the cursor query param, null when done; the cursor carries the original filters and other params are ignored on later pages, so dlt resending limit and the *_min filter is harmless. limit max is 500 (default 100). The since_id style is documented as going away, so it is not used. Incremental: customers and orders filter on updated_at_min (ISO 8601); activities and transactions only document created_at_min, so they increment on created_at. Activities can later change state (Update Activity exists, e.g. pending to approved), which a created_at cursor will not pick up; a periodic full resync of activities (reset its state) is advisable. Results come newest first; dlt takes the max cursor value so ordering does not matter. Rate limit 20 requests per second. transactions also supports type=csv; the default json is used. Not included: customer exports (async create then poll, not expressible) and the deprecated token+secret basic auth."
    },
    {
        "slug": "growave",
        "name": "Growave",
        "category": "loyalty",
        "readiness": "planned",
        "why": "#64 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 11,667 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/growave",
        "docs": "",
        "credentials": [],
        "params": [],
        "notes": "API is partner-only or needs vendor approval. CSV import meanwhile."
    },
    {
        "slug": "junip",
        "name": "Junip",
        "category": "reviews",
        "readiness": "planned",
        "why": "#65 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 8,111 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/junip",
        "docs": "https://junip.co/docs/api",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "re-amaze",
        "name": "Re:amaze",
        "category": "helpdesk",
        "readiness": "built",
        "why": "#66 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 3,607 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/reamaze",
        "docs": "https://www.reamaze.com/api",
        "credentials": [
            {
                "name": "api_token",
                "label": "API token",
                "help": "In Re:amaze go to Settings, then under Developer click API Token, then Generate New Token. Tokens are per user and act with that user's permissions; Re:amaze has no read-only token scope, so generate it from a user with the least access that can still see all conversations. This connector only sends GET requests."
            }
        ],
        "params": [
            {
                "name": "brand",
                "label": "Brand subdomain (the part before .reamaze.io, shown on the Brand Settings page)",
                "example": "acme"
            },
            {
                "name": "login_email",
                "label": "Login email of the user who generated the token",
                "example": "support@acme.com"
            }
        ],
        "config": {
            "client": {
                "base_url": "https://{param:brand}.reamaze.io/api/v1/",
                "auth": {
                    "type": "http_basic",
                    "username": "{param:login_email}",
                    "password": "{secret:api_token}"
                },
                "headers": {
                    "Accept": "application/json"
                },
                "paginator": {
                    "type": "page_number",
                    "page_param": "page",
                    "base_page": 1,
                    "total_path": "page_count"
                }
            },
            "resource_defaults": {
                "write_disposition": "merge"
            },
            "resources": [
                {
                    "name": "conversations",
                    "primary_key": "slug",
                    "endpoint": {
                        "path": "conversations",
                        "params": {
                            "filter": "all"
                        },
                        "data_selector": "conversations"
                    }
                },
                {
                    "name": "messages",
                    "write_disposition": "append",
                    "endpoint": {
                        "path": "messages",
                        "data_selector": "messages",
                        "incremental": {
                            "start_param": "start_date",
                            "cursor_path": "created_at",
                            "initial_value": "2015-01-01T00:00:00Z"
                        }
                    }
                },
                {
                    "name": "satisfaction_ratings",
                    "primary_key": "id",
                    "endpoint": {
                        "path": "satisfaction_ratings",
                        "data_selector": "satisfaction_ratings",
                        "incremental": {
                            "start_param": "updated_after",
                            "cursor_path": "updated_at",
                            "initial_value": "2015-01-01T00:00:00Z"
                        }
                    }
                }
            ]
        },
        "notes": "All GET. Auth is HTTP Basic with the user's login email and API token, plus Accept: application/json (Introduction page). Requests are scoped to one brand by host; a multi-brand account needs one connection per brand. Pagination: page param with page_size, page_count and total_count in the body, so the page_number paginator stops at page_count. No page-size parameter is documented (examples show 30 per page), so none is sent. conversations: keyed on slug (the documented unique id); filter=all so archived ones are included; start_date/end_date filter on the latest customer message, not on last change, so conversations are a full refresh merged on slug. messages: the docs show no id field on a message, so they are loaded append-only and incrementally on created_at via start_date (documented as a creation-date filter); dlt dedupes the boundary rows by content. satisfaction_ratings: incremental via the documented updated_after filter on updated_at, merged on id. Contacts were left out (no documented id field and mostly personal data). Rate limits are per token per minute and not published; 429s are retried by dlt."
    },
    {
        "slug": "richpanel",
        "name": "Richpanel",
        "category": "helpdesk",
        "readiness": "planned",
        "why": "#67 of 100 tools Shopify stores use. Ranking position is judgment. No StoreLeads count checked. DTC-focused Gorgias alternative. Source: https://www.richpanel.com/",
        "docs": "https://developer.richpanel.com/",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "kustomer",
        "name": "Kustomer",
        "category": "helpdesk",
        "readiness": "built",
        "why": "#68 of 100 tools Shopify stores use. Ranking position is judgment. No count. Used by larger DTC brands as a Gorgias/Zendesk alternative. Source: https://developer.kustomer.com/",
        "docs": "https://developer.kustomer.com/api",
        "credentials": [
            {
                "name": "api_key",
                "label": "API key",
                "help": "As a Kustomer admin go to Settings, Security, API Keys and select Add API Key. Grant only the read roles org.permission.conversation.read, org.permission.message.read and org.permission.customer.read (roles cannot be edited later; create a new key to change them). Set an expiry if your policy requires one."
            }
        ],
        "params": [
            {
                "name": "org",
                "label": "Org name (the subdomain you sign in at, acme for acme.kustomerapp.com)",
                "example": "acme"
            }
        ],
        "config": {
            "client": {
                "base_url": "https://{param:org}.api.kustomerapp.com/v1/",
                "auth": {
                    "type": "bearer",
                    "token": "{secret:api_key}"
                },
                "paginator": {
                    "type": "json_link",
                    "next_url_path": "links.next"
                }
            },
            "resource_defaults": {
                "primary_key": "id",
                "write_disposition": "merge",
                "endpoint": {
                    "data_selector": "data",
                    "params": {
                        "pageSize": 100
                    }
                }
            },
            "resources": [
                {
                    "name": "conversations",
                    "endpoint": {
                        "path": "conversations"
                    }
                },
                {
                    "name": "messages",
                    "endpoint": {
                        "path": "messages"
                    }
                },
                {
                    "name": "customers",
                    "endpoint": {
                        "path": "customers",
                        "params": {
                            "sort": "updatedAt"
                        },
                        "incremental": {
                            "start_param": "filter[updatedAt][gte]",
                            "cursor_path": "attributes.updatedAt",
                            "initial_value": "2015-01-01T00:00:00Z"
                        }
                    }
                }
            ]
        },
        "notes": "All GET. Bearer API key against the org host https://<org>.api.kustomerapp.com, which routes to the US, EU or India region automatically. Pagination: follow links.next until null; links.next is a path (/v1/...), which dlt joins onto the host. pageSize 100 is the documented typical maximum for most lists (per-endpoint maxima are not stated on these reference pages). Records are JSON:API style, so fields sit under attributes (attributes.updatedAt, attributes.status, etc.). customers: incremental via the documented filter[updatedAt][gte] with sort=updatedAt (ascending). conversations and messages: GET /v1/conversations and /v1/messages document only page, pageSize and sort (no date filter), so they are full refresh merged on id; on large orgs that is many pages. A cheaper incremental path exists through the read-only search endpoint (POST /v1/customers/search with an updated_at window, needs org.permission.search.create) but it caps at 10,000 matches per query and needs a POST body, so it was not used here. Rate limits are org-wide by plan; dlt retries 429."
    },
    {
        "slug": "hotjar",
        "name": "Hotjar",
        "category": "analytics",
        "readiness": "planned",
        "why": "#69 of 100 tools Shopify stores use. StoreLeads: detected on 49,399 Shopify stores (Oct 30 2026 snapshot). Alium: often replaced by Microsoft Clarity. Source: https://storeleads.app/reports/technology/Hotjar",
        "docs": "https://help.hotjar.com/hc/en-us/articles/36820005914001-Hotjar-API-Reference",
        "credentials": [],
        "params": [],
        "notes": "API is partner-only or needs vendor approval. CSV import meanwhile."
    },
    {
        "slug": "snapchat-ads",
        "name": "Snapchat Ads",
        "category": "ads",
        "readiness": "planned",
        "why": "#70 of 100 tools Shopify stores use. Ranking position is judgment. StoreLeads: Snapchat account on 7,171 Shopify stores; pixel page not found. Smaller paid channel for DTC. Source: https://storeleads.app/reports/shopify",
        "docs": "https://developers.snap.com/api/marketing-api/Ads-API/introduction",
        "credentials": [],
        "params": [],
        "notes": "Needs an OAuth sign-in flow, not built yet. CSV import meanwhile."
    },
    {
        "slug": "tiktok-shop",
        "name": "TikTok Shop",
        "category": "marketplaces",
        "readiness": "planned",
        "why": "#71 of 100 tools Shopify stores use. Ranking position is judgment. No count found. Fast-growing channel for DTC brands; data lives outside Shopify. Source: https://partner.tiktokshop.com/docv2",
        "docs": "https://partner.tiktokshop.com/docv2",
        "credentials": [],
        "params": [],
        "notes": "API is partner-only or needs vendor approval. CSV import meanwhile."
    },
    {
        "slug": "walmart-marketplace",
        "name": "Walmart Marketplace",
        "category": "marketplaces",
        "readiness": "planned",
        "why": "#72 of 100 tools Shopify stores use. Ranking position is judgment. No count. Third most common marketplace for US DTC brands after Amazon and TikTok Shop. Source: https://developer.walmart.com/",
        "docs": "https://developer.walmart.com/doc/us/mp/us-mp-auth/",
        "credentials": [],
        "params": [],
        "notes": "Needs an OAuth sign-in flow, not built yet. CSV import meanwhile."
    },
    {
        "slug": "faire",
        "name": "Faire",
        "category": "marketplaces",
        "readiness": "planned",
        "why": "#73 of 100 tools Shopify stores use. Ranking position is judgment. Taylor Sicard lists Faire wholesale as an explore item for $5M-$20M brands. Source: https://taylorsicard.com/blog/shopify-tech-stack-by-revenue",
        "docs": "https://faire.github.io/external-api-v2-docs/",
        "credentials": [],
        "params": [],
        "notes": "API is partner-only or needs vendor approval. CSV import meanwhile."
    },
    {
        "slug": "shiphero",
        "name": "ShipHero",
        "category": "shipping",
        "readiness": "planned",
        "why": "#74 of 100 tools Shopify stores use. Ranking position is judgment. No count. Flow.space and txtcart.ai list it among top Shopify 3PL/WMS options. Source: https://flow.space/blog/best-3pl-for-shopify",
        "docs": "https://developer.shiphero.com/",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "shipmonk",
        "name": "ShipMonk",
        "category": "shipping",
        "readiness": "planned",
        "why": "#75 of 100 tools Shopify stores use. Ranking position is judgment. No count. txtcart.ai names it the closest like-for-like ShipBob swap. Source: https://txtcart.ai/blog/shipbob-alternatives/",
        "docs": "",
        "credentials": [],
        "params": [],
        "notes": "API is partner-only or needs vendor approval. CSV import meanwhile."
    },
    {
        "slug": "shippo",
        "name": "Shippo",
        "category": "shipping",
        "readiness": "built",
        "why": "#76 of 100 tools Shopify stores use. Ranking position is judgment. No count. Common label software for in-house fulfillment. Source: https://goshippo.com/",
        "docs": "https://docs.goshippo.com/api-reference/overview",
        "credentials": [
            {
                "name": "api_token",
                "label": "Live API token",
                "help": "Log in to the Shippo API portal (https://portal.goshippo.com/api-config/api), open API Configuration, Developer keys, and click Create new live key (it starts with shippo_live_). Shippo keys have no read-only scope option; this connector only sends GET requests. Use a shippo_test_ key only if you want test-mode data, since test and live data are separate."
            }
        ],
        "params": [],
        "config": {
            "client": {
                "base_url": "https://api.goshippo.com/",
                "auth": {
                    "type": "api_key",
                    "name": "Authorization",
                    "api_key": "ShippoToken {secret:api_token}",
                    "location": "header"
                },
                "paginator": {
                    "type": "json_link",
                    "next_url_path": "next"
                }
            },
            "resource_defaults": {
                "primary_key": "object_id",
                "write_disposition": "merge",
                "endpoint": {
                    "data_selector": "results",
                    "params": {
                        "results": 100
                    }
                }
            },
            "resources": [
                {
                    "name": "transactions",
                    "endpoint": {
                        "path": "transactions"
                    }
                },
                {
                    "name": "orders",
                    "endpoint": {
                        "path": "orders"
                    }
                },
                {
                    "name": "refunds",
                    "endpoint": {
                        "path": "refunds/"
                    }
                }
            ]
        },
        "notes": "All GET. Auth header is 'Authorization: ShippoToken <token>' (security scheme APIKeyHeader with x-token-prefix ShippoToken), so api_key auth is used with the prefix in the value. Pagination: list responses are {next, previous, results}; next is a full URL (filtering guide example) and is followed with json_link. Page size param is results; the OpenAPI spec says max 100 (default 25), while the older filtering guide says to stay under 200, so 100 is used. transactions are the purchased labels and carry tracking_number, tracking_status and rate; this is the core shipping table. Shipments were left out on purpose: every rate quote creates a shipment, so the table is very large and mostly unpurchased quotes, and its only date filter (object_created_*) is documented as limited to 90-day windows. No incremental: transactions only filter on object_created (tracking_status and refunds change after creation), orders filter on placed_at (start_date) and refunds have no filters, so everything is full refresh merged on object_id. The refunds path is documented with a trailing slash (/refunds/). Orders only hold data if the store is connected to Shippo (e.g. the Shopify app)."
    },
    {
        "slug": "cin7",
        "name": "Cin7",
        "category": "ops-erp",
        "readiness": "planned",
        "why": "#77 of 100 tools Shopify stores use. Ranking position is judgment. No count. Common inventory/OMS for multichannel brands below NetSuite scale. Source: https://www.cin7.com/",
        "docs": "https://dearinventory.docs.apiary.io/",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "inventory-planner",
        "name": "Inventory Planner",
        "category": "ops-erp",
        "readiness": "planned",
        "why": "#78 of 100 tools Shopify stores use. Ranking position is judgment. No count. Common demand planning add-on for $1M-$10M Shopify brands. Source: https://www.inventory-planner.com/",
        "docs": "https://help.inventory-planner.com/en/articles/2565547-public-api",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "a2x",
        "name": "A2X",
        "category": "accounting",
        "readiness": "planned",
        "why": "#79 of 100 tools Shopify stores use. A2X homepage: trusted by 13,000+ businesses and accountants (vendor claim); syncs Shopify and Amazon payouts to QuickBooks/Xero. Source: https://www.a2xaccounting.com/",
        "docs": "",
        "credentials": [],
        "params": [],
        "notes": "No public data API. Bring daily totals in with lifecycle sources import."
    },
    {
        "slug": "taxjar",
        "name": "TaxJar",
        "category": "tax",
        "readiness": "planned",
        "why": "#80 of 100 tools Shopify stores use. Ranking position is judgment. No count. Stripe-owned sales tax tool used by smaller US brands. Source: https://developers.taxjar.com/api/reference/",
        "docs": "https://developers.taxjar.com/api/reference/",
        "credentials": [],
        "params": [],
        "notes": "List endpoints return only IDs and skip transactions synced from Shopify, so a connector would mislead. CSV import instead."
    },
    {
        "slug": "impact",
        "name": "impact.com",
        "category": "affiliate",
        "readiness": "planned",
        "why": "#81 of 100 tools Shopify stores use. Ranking position is judgment. No count. Enterprise affiliate network used by larger DTC brands. Source: https://integrations.impact.com/impact-brand/reference",
        "docs": "https://integrations.impact.com/impact-brand/reference",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "social-snowball",
        "name": "Social Snowball",
        "category": "affiliate",
        "readiness": "planned",
        "why": "#82 of 100 tools Shopify stores use. Ranking position is judgment. Taylor Sicard lists Social Snowball for $5M-$20M brands. Source: https://taylorsicard.com/blog/shopify-tech-stack-by-revenue",
        "docs": "",
        "credentials": [],
        "params": [],
        "notes": "API is partner-only or needs vendor approval. CSV import meanwhile."
    },
    {
        "slug": "uppromote",
        "name": "UpPromote",
        "category": "affiliate",
        "readiness": "planned",
        "why": "#83 of 100 tools Shopify stores use. Ranking position is judgment. No StoreLeads count verified (slug guess 404). Large-install Shopify affiliate app. Source: https://uppromote.com/",
        "docs": "https://docs.uppromote.com/",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "awin",
        "name": "Awin (ShareASale)",
        "category": "affiliate",
        "readiness": "planned",
        "why": "#84 of 100 tools Shopify stores use. Ranking position is judgment. No count. ShareASale merged into Awin; common affiliate network for DTC. Source: https://developer.awin.com/",
        "docs": "https://developer.awin.com/",
        "credentials": [],
        "params": [],
        "notes": "Needs an OAuth sign-in flow, not built yet. CSV import meanwhile."
    },
    {
        "slug": "grin",
        "name": "GRIN",
        "category": "affiliate",
        "readiness": "planned",
        "why": "#85 of 100 tools Shopify stores use. Ranking position is judgment. No count. Leading influencer CRM for DTC brands. Source: https://grin.co/",
        "docs": "",
        "credentials": [],
        "params": [],
        "notes": "API is partner-only or needs vendor approval. CSV import meanwhile."
    },
    {
        "slug": "pagefly",
        "name": "PageFly",
        "category": "page-builders",
        "readiness": "planned",
        "why": "#86 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 186,621 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/pagefly",
        "docs": "",
        "credentials": [],
        "params": [],
        "notes": "No public data API. Bring daily totals in with lifecycle sources import."
    },
    {
        "slug": "gempages",
        "name": "GemPages",
        "category": "page-builders",
        "readiness": "planned",
        "why": "#87 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 59,065 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/gempages",
        "docs": "",
        "credentials": [],
        "params": [],
        "notes": "No public data API. Bring daily totals in with lifecycle sources import."
    },
    {
        "slug": "shogun",
        "name": "Shogun",
        "category": "page-builders",
        "readiness": "planned",
        "why": "#88 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 32,509 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/shogun",
        "docs": "",
        "credentials": [],
        "params": [],
        "notes": "No public data API. Bring daily totals in with lifecycle sources import."
    },
    {
        "slug": "printful",
        "name": "Printful",
        "category": "shipping",
        "readiness": "planned",
        "why": "#89 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 145,754 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/printful",
        "docs": "https://developers.printful.com/docs/",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "feedonomics",
        "name": "Feedonomics",
        "category": "product-feeds",
        "readiness": "planned",
        "why": "#90 of 100 tools Shopify stores use. Ranking position is judgment. No count. Common managed feed service for brands selling across Google, Meta, Amazon. Source: https://feedonomics.com/",
        "docs": "",
        "credentials": [],
        "params": [],
        "notes": "API is partner-only or needs vendor approval. CSV import meanwhile."
    },
    {
        "slug": "freshdesk",
        "name": "Freshdesk",
        "category": "helpdesk",
        "readiness": "built",
        "why": "#91 of 100 tools Shopify stores use. Ranking position is judgment. No StoreLeads count checked. Used by some Shopify brands. Source: https://developers.freshdesk.com/api/",
        "docs": "https://developers.freshdesk.com/api/",
        "credentials": [
            {
                "name": "api_key",
                "label": "API key",
                "help": "In the Freshdesk support portal, click your profile picture (top right), open Profile settings, and copy the API key shown below the change password section (you may have to click View API key). Freshdesk keys are personal and cannot be scoped, so the key carries that agent's permissions; use an agent with read access to all tickets, ideally a dedicated reporting agent."
            }
        ],
        "params": [
            {
                "name": "domain",
                "label": "Freshdesk subdomain (the part before .freshdesk.com)",
                "example": "acmecoffee"
            }
        ],
        "config": {
            "client": {
                "base_url": "https://{param:domain}.freshdesk.com/api/v2/",
                "auth": {
                    "type": "http_basic",
                    "username": "{secret:api_key}",
                    "password": "X"
                },
                "paginator": {
                    "type": "header_link",
                    "links_next_key": "next"
                }
            },
            "resource_defaults": {
                "primary_key": "id",
                "write_disposition": "merge"
            },
            "resources": [
                {
                    "name": "tickets",
                    "endpoint": {
                        "path": "tickets",
                        "data_selector": "$",
                        "params": {
                            "per_page": 100,
                            "order_by": "updated_at",
                            "order_type": "asc",
                            "include": "stats",
                            "updated_since": {
                                "type": "incremental",
                                "cursor_path": "updated_at",
                                "initial_value": "2015-01-01T00:00:00Z"
                            }
                        }
                    }
                },
                {
                    "name": "contacts",
                    "endpoint": {
                        "path": "contacts",
                        "data_selector": "$",
                        "params": {
                            "per_page": 100,
                            "updated_since": {
                                "type": "incremental",
                                "cursor_path": "updated_at",
                                "initial_value": "2015-01-01T00:00:00Z"
                            }
                        }
                    }
                },
                {
                    "name": "satisfaction_ratings",
                    "endpoint": {
                        "path": "surveys/satisfaction_ratings",
                        "data_selector": "$",
                        "params": {
                            "per_page": 100,
                            "created_since": {
                                "type": "incremental",
                                "cursor_path": "created_at",
                                "initial_value": "2015-01-01T00:00:00Z"
                            }
                        },
                        "response_actions": [
                            {
                                "status_code": 404,
                                "action": "ignore"
                            }
                        ]
                    }
                },
                {
                    "name": "csat_surveys",
                    "endpoint": {
                        "path": "customer-satisfaction/surveys",
                        "data_selector": "data",
                        "params": {
                            "per_page": 100
                        },
                        "paginator": {
                            "type": "json_link",
                            "next_url_path": "paging.next"
                        },
                        "response_actions": [
                            {
                                "status_code": 404,
                                "action": "ignore"
                            }
                        ]
                    }
                },
                {
                    "name": "csat_survey_responses",
                    "endpoint": {
                        "path": "customer-satisfaction/surveys/{resources.csat_surveys.id}/responses",
                        "data_selector": "data",
                        "params": {
                            "per_page": 100
                        },
                        "paginator": {
                            "type": "json_link",
                            "next_url_path": "paging.next"
                        },
                        "response_actions": [
                            {
                                "status_code": 404,
                                "action": "ignore"
                            }
                        ]
                    },
                    "include_from_parent": [
                        "id"
                    ]
                }
            ]
        },
        "notes": "Auth is HTTP basic with the API key as username and any dummy password (docs use X). List endpoints return a bare JSON array; pagination is page/per_page (max 100) with the next page in the Link header (rel=next), which is absent on the last page. Tickets: by default the list only returns tickets created in the past 30 days, so updated_since is always sent (incremental on updated_at, initial 2015-01-01), and the list caps at 300 pages (30,000 tickets) per query; sorting by updated_at ascending means a first sync of a very large account stops at the cap and later runs continue from the last updated_at. include=stats adds closed_at, resolved_at, first_responded_at but costs 3 API credits per call instead of 1; drop it if the plan's rate limit is tight. Ticket conversations (per-ticket child endpoint) were left out to keep API usage sane. CSAT: Freshdesk has two CSAT APIs. Legacy /surveys/satisfaction_ratings applies to accounts created before December 2025 that have not moved to New CSAT (it keeps working for upgraded accounts only until their survey config changes). New CSAT is /customer-satisfaction/surveys plus /surveys/{id}/responses (data + paging.next, max per_page 100). Both are included with a 404 ignore so whichever one the account lacks is skipped; I could not confirm which status code the unsupported variant returns (it may be 400 or 403 instead of 404), so test on a real account. Legacy ratings pagination is assumed to follow the general Link-header scheme; the endpoint section does not restate it. csat_survey_responses ids are strings like _4-62 and the parent survey id is carried as _csat_surveys_id."
    },
    {
        "slug": "stay-ai",
        "name": "Stay AI",
        "category": "subscriptions",
        "readiness": "planned",
        "why": "#92 of 100 tools Shopify stores use. Ranking position is judgment. No StoreLeads count checked. Growing Recharge alternative named by Solo Media Group in the core DTC stack. Source: https://solomediagroup.com/blogs/insights/best-shopify-apps-for-dtc-brands",
        "docs": "https://docs.stay.ai/",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "smartrr",
        "name": "Smartrr",
        "category": "subscriptions",
        "readiness": "planned",
        "why": "#93 of 100 tools Shopify stores use. StoreLeads: Shopify app installed on 468 Shopify stores (Oct 30 2026 snapshot). Source: https://storeleads.app/reports/shopify/app/smartrr",
        "docs": "https://docs.smartrr.com/",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "ordergroove",
        "name": "Ordergroove",
        "category": "subscriptions",
        "readiness": "planned",
        "why": "#94 of 100 tools Shopify stores use. Ranking position is judgment. No count. Enterprise subscription platform with a Shopify app. Source: https://developer.ordergroove.com/",
        "docs": "https://developer.ordergroove.com/",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "narvar",
        "name": "Narvar",
        "category": "returns",
        "readiness": "planned",
        "why": "#95 of 100 tools Shopify stores use. Alium: about 1.5x more common on non-Shopify platforms; enterprise returns/tracking. Source: https://www.alium.io/research/shopify-dtc-stack",
        "docs": "",
        "credentials": [],
        "params": [],
        "notes": "API is partner-only or needs vendor approval. CSV import meanwhile."
    },
    {
        "slug": "shoplift",
        "name": "Shoplift",
        "category": "upsell-cro",
        "readiness": "planned",
        "why": "#96 of 100 tools Shopify stores use. Alium: Shopify-only A/B testing tool; Solo Media Group names it with Intelligems as the testing pick. Source: https://www.alium.io/research/shopify-dtc-stack",
        "docs": "",
        "credentials": [],
        "params": [],
        "notes": "No public data API. Bring daily totals in with lifecycle sources import."
    },
    {
        "slug": "replo",
        "name": "Replo",
        "category": "page-builders",
        "readiness": "planned",
        "why": "#97 of 100 tools Shopify stores use. Ranking position is judgment. No StoreLeads page (slug 404). Popular with DTC agencies. Source: https://www.replo.app/",
        "docs": "",
        "credentials": [],
        "params": [],
        "notes": "No public data API. Bring daily totals in with lifecycle sources import."
    },
    {
        "slug": "tapcart",
        "name": "Tapcart",
        "category": "upsell-cro",
        "readiness": "planned",
        "why": "#98 of 100 tools Shopify stores use. Alium: named as mobile app platform in a DTC beauty stack story. Source: https://www.alium.io/research/shopify-dtc-stack",
        "docs": "",
        "credentials": [],
        "params": [],
        "notes": "API is partner-only or needs vendor approval. CSV import meanwhile."
    },
    {
        "slug": "wonderment",
        "name": "Wonderment",
        "category": "shipping",
        "readiness": "planned",
        "why": "#99 of 100 tools Shopify stores use. Taylor Sicard lists Wonderment or AfterShip for shipping visibility at $5M-$20M. Source: https://taylorsicard.com/blog/shopify-tech-stack-by-revenue",
        "docs": "https://docs.wonderment.com/",
        "credentials": [],
        "params": [],
        "notes": "Public API; connector not written yet. Describe it with lifecycle warehouse add-api, or use CSV import."
    },
    {
        "slug": "littledata",
        "name": "Littledata",
        "category": "analytics",
        "readiness": "planned",
        "why": "#100 of 100 tools Shopify stores use. 1Digital lists Littledata in its 15 must-have apps for 7-figure DTC brands. Source: https://www.1digitalagency.com/blog/the-2026-shopify-tech-stack-15-essential-apps-for-a-7-figure-dtc-brand/",
        "docs": "",
        "credentials": [],
        "params": [],
        "notes": "No public data API. Bring daily totals in with lifecycle sources import."
    }
];
