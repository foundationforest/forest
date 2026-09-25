// Structured data for machines: schema.org JSON-LD, one `@graph` per page, so search engines and
// shopping AIs read the page natively. Built from the same model as the HTML and the twin.
//
// Two things schema.org decides for us:
//   - `review` and `aggregateRating` do not take a Person. So reviews and the rating are nodes of
//     their own whose `itemReviewed` (any Thing) is the profile, Person or LocalBusiness alike.
//   - A rating needs a bounded scale; trust has none (a sum that can go below zero). The rating is
//     trust squashed onto 1 to 5 by the same curve the reviewer weight uses, t / (|t| + 1), and
//     says so in `ratingExplanation`. It is trust alone: uniqueness is never blended in.

import type { CurrencyConfig as Currencies } from '../config.ts'
import type { DealModel, MarketModel, Offer, ProfileModel, Review, SearchModel, CategoryModel, HomeModel } from './data.ts'
import { money, moneyFromBase, title } from './words.ts'

type Node = Record<string, unknown>
const CONTEXT = 'https://schema.org'
const graph = (nodes: Node[]) => ({ '@context': CONTEXT, '@graph': nodes })
const ref = (id: string) => ({ '@id': id })

/** Trust on a 1 to 5 scale: 3 at zero, towards 5 as it grows, towards 1 as it falls. */
export function trustAsRating(t: number): number {
  return Math.round((3 + (2 * t) / (Math.abs(t) + 1)) * 100) / 100
}

export const RATING_EXPLANATION =
  'This index’s trust score, from reviews weighed by who wrote them and the payment behind them, put on a 1 to 5 scale as 3 + 2·t/(|t|+1). It is not an average of stars. See index/SCORING.md in the Forest repository.'

function offerNode(o: Offer, currencies: Currencies, seller: Node): Node {
  const m = money(o.price.amount, o.price.mint, currencies)
  const node: Node = {
    '@type': 'Offer',
    identifier: o.uri,
    url: o.profileUrl,
    seller,
    itemOffered: {
      '@type': 'Service',
      name: o.market ? title(o.market) : title(o.marketWritten),
      serviceType: o.market ?? o.marketWritten,
      description: o.description,
      provider: seller,
      ...(o.remote ? {} : o.location ? { areaServed: o.location } : {}),
    },
  }
  if (m.known) {
    node.price = m.decimal
    node.priceCurrency = m.code
    node.priceSpecification = { '@type': 'UnitPriceSpecification', price: m.decimal, priceCurrency: m.code, unitText: o.price.per }
  }
  if (o.expires) node.validThrough = o.expires
  return node
}

function personRef(name: string | null, url: string): Node {
  return { '@type': 'Person', ...(name ? { name } : {}), url }
}

function reviewNode(v: Review, itemReviewed: Node, id: string): Node {
  return {
    '@type': 'Review',
    '@id': id,
    identifier: v.uri,
    itemReviewed,
    author: personRef(v.reviewerName, v.reviewerUrl),
    ...(v.rating !== null ? { reviewRating: { '@type': 'Rating', ratingValue: v.rating, bestRating: 5, worstRating: 1 } } : {}),
    ...(v.text ? { reviewBody: v.text } : {}),
    ...(v.createdAt ? { datePublished: v.createdAt } : {}),
  }
}

export function homeLd(m: HomeModel): unknown {
  return graph([
    { '@type': 'WebSite', '@id': m.url, url: m.url, name: 'Forest', description: m.index.about },
    {
      '@type': 'ItemList',
      name: 'Categories',
      itemListElement: m.categories.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: title(c.category), url: c.url })),
    },
  ])
}

export function categoryLd(m: CategoryModel): unknown {
  return graph([
    {
      '@type': 'CollectionPage',
      '@id': m.url,
      url: m.url,
      name: title(m.category),
      mainEntity: {
        '@type': 'ItemList',
        itemListElement: m.markets.map((x, i) => ({ '@type': 'ListItem', position: i + 1, name: title(x.name), url: x.url })),
      },
    },
  ])
}

export function marketLd(m: MarketModel, currencies: Currencies): unknown {
  return graph([
    {
      '@type': 'CollectionPage',
      '@id': m.url,
      url: m.url,
      name: title(m.market.name),
      ...(m.market.description ? { description: m.market.description } : {}),
      mainEntity: {
        '@type': 'OfferCatalog',
        name: `${title(m.market.name)}: offers`,
        numberOfItems: m.total,
        itemListElement: m.offers.map((o) => offerNode(o, currencies, personRef(o.name, o.profileUrl))),
      },
    },
  ])
}

export function profileLd(m: ProfileModel, currencies: Currencies): unknown {
  const id = `${m.url}#profile`
  const place = m.offers.find((o) => !o.remote && o.location)?.location ?? null
  const subject: Node = {
    '@type': place ? 'LocalBusiness' : 'Person',
    '@id': id,
    name: m.profile.name,
    url: m.url,
    identifier: m.did,
    ...(m.profile.about ? { description: m.profile.about } : {}),
    ...(place ? { address: place } : {}),
    makesOffer: m.offers.map((o) => offerNode(o, currencies, ref(id))),
  }
  const nodes: Node[] = [{ '@type': 'ProfilePage', '@id': m.url, url: m.url, name: m.profile.name, mainEntity: ref(id) }, subject]
  const rated = m.reviews.received.filter((v) => v.counted && v.rating !== null)
  if (m.scores.trust && rated.length) {
    nodes.push({
      '@type': 'AggregateRating',
      '@id': `${m.url}#trust`,
      itemReviewed: ref(id),
      ratingValue: trustAsRating(m.scores.trust.value),
      bestRating: 5,
      worstRating: 1,
      reviewCount: rated.length,
      ratingExplanation: RATING_EXPLANATION,
    })
  }
  m.reviews.received.forEach((v, i) => nodes.push(reviewNode(v, ref(id), `${m.url}#review-${i + 1}`)))
  return graph(nodes)
}

export function dealLd(m: DealModel, currencies: Currencies): unknown {
  const nodes: Node[] = [{ '@type': 'WebPage', '@id': m.url, url: m.url, name: 'Payment receipt' }]
  const r = m.receipt
  if (r) {
    const buyer = r.buyerProfiles[0]
    const seller = r.sellerProfiles[0]
    const amount = moneyFromBase(r.amount, r.mint, currencies)
    nodes.push({
      '@type': 'PayAction',
      '@id': `${m.url}#payment`,
      identifier: r.escrow,
      ...(buyer ? { agent: personRef(buyer.name, buyer.url) } : {}),
      ...(seller ? { recipient: personRef(seller.name, seller.url) } : {}),
      ...(amount.known ? { price: amount.decimal, priceCurrency: amount.code } : {}),
      ...(r.createdAt ? { startTime: r.createdAt } : {}),
      ...(r.endedAt ? { endTime: r.endedAt } : {}),
      actionStatus: r.endedAt ? 'https://schema.org/CompletedActionStatus' : 'https://schema.org/ActiveActionStatus',
    })
  }
  m.reviews.forEach((v, i) => nodes.push(reviewNode(v, personRef(v.subjectName, v.subjectUrl), `${m.url}#review-${i + 1}`)))
  return graph(nodes)
}

export function searchLd(m: SearchModel, currencies: Currencies): unknown {
  return graph([
    {
      '@type': 'SearchResultsPage',
      '@id': m.url,
      url: m.url,
      name: m.q ? `Search: ${m.q}` : 'Search',
      mainEntity: {
        '@type': 'ItemList',
        numberOfItems: m.total,
        itemListElement: m.offers.map((o) => offerNode(o, currencies, personRef(o.name, o.profileUrl))),
      },
    },
  ])
}

export function payLd(url: string, offer: Offer | null, currencies: Currencies): unknown {
  return graph([
    {
      '@type': 'WebPage',
      '@id': url,
      url,
      name: 'Pay for an offer',
      ...(offer ? { mainEntity: offerNode(offer, currencies, personRef(offer.name, offer.profileUrl)) } : {}),
    },
  ])
}
