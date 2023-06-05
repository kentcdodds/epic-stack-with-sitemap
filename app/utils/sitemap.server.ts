import { type EntryContext } from '@remix-run/node'
import { z } from 'zod'
import { getDomainUrl } from './misc.server.ts'
import { type RemixContextObject } from '@remix-run/react/dist/entry.js'

const SitemapEntrySchema = z.object({
	route: z.string(),
	lastmod: z.date().optional(),
	changefreq: z
		.enum(['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'])
		.optional(),
	priority: z
		.union([
			z.literal(0.0),
			z.literal(0.1),
			z.literal(0.2),
			z.literal(0.3),
			z.literal(0.4),
			z.literal(0.5),
			z.literal(0.6),
			z.literal(0.7),
			z.literal(0.8),
			z.literal(0.9),
			z.literal(1.0),
		])
		.optional(),
})
const SitemapEntriesSchema = z.array(SitemapEntrySchema).nullable()
const HandleSchema = z
	.object({
		getSitemapEntries: z.function().optional().nullable(),
	})
	.optional()

type SitemapEntry = z.infer<typeof SitemapEntrySchema>

type GetSitemapArgs = {
	id: string
	request: Request
	remixContext: RemixContextObject
}

type GetSitemapEntriesFunction = (
	args: GetSitemapArgs,
) =>
	| Promise<Array<SitemapEntry | null> | null>
	| Promise<SitemapEntry | null>
	| Array<SitemapEntry | null>
	| SitemapEntry
	| null

export type SitemapHandle = {
	getSitemapEntries?: GetSitemapEntriesFunction | null
}

function removeTrailingSlash(s: string) {
	return s.endsWith('/') ? s.slice(0, -1) : s
}

function isEqual(obj1: any, obj2: any) {
	// check whether obj1 and obj2 have the same properties and values
	// must do the check deeply for nested objects and arrays
	// and cannot use JSON.stringify because the order of keys is not guaranteed
	// and cannot use lodash.isEqual because it's unnecessarily large
	const keys1 = Object.keys(obj1)
	const keys2 = Object.keys(obj2)
	if (keys1.length !== keys2.length) return false
	for (const key of keys1) {
		const val1 = obj1[key]
		const val2 = obj2[key]
		if (typeof val1 === 'object' && typeof val2 === 'object') {
			if (!isEqual(val1, val2)) return false
		} else if (val1 !== val2) {
			return false
		}
	}
	return true
}

const defaultGetSitemapHandle: GetSitemapEntriesFunction = ({
	id,
	remixContext,
}) => {
	const manifestEntry = remixContext.manifest.routes[id]
	if (!manifestEntry) {
		console.warn(`Could not find a manifest entry for ${id}`)
		return null
	}
	let parentId = manifestEntry.parentId
	let parent = parentId ? remixContext.manifest.routes[parentId] : null

	let path
	if (manifestEntry.path) {
		path = removeTrailingSlash(manifestEntry.path)
	} else if (manifestEntry.index) {
		path = ''
	} else {
		return null
	}

	while (parent) {
		if (
			parentId &&
			remixContext.routeModules[parentId].handle?.getSitemapEntries === null
		) {
			// if a parent has opted out of the sitemap by setting it to null,
			// then the children will be opted-out of the default sitemap as well.
			return null
		}
		// the root path is '/', so it messes things up if we add another '/'
		const parentPath = parent.path ? removeTrailingSlash(parent.path) : ''
		path = `${parentPath}/${path}`
		parentId = parent.parentId
		parent = parentId ? remixContext.manifest.routes[parentId] : null
	}

	// we can't handle dynamic routes, so if the handle doesn't have a
	// getSitemapEntries function, we just return
	if (path.includes(':')) return null
	if (id === 'root') return null

	return { route: removeTrailingSlash(path) }
}

async function getSitemapXml(request: Request, remixContext: EntryContext) {
	const domainUrl = getDomainUrl(request)

	function getEntry({ route, lastmod, changefreq, priority }: SitemapEntry) {
		return `
<url>
	<loc>${domainUrl}${route}</loc>
	${lastmod ? `<lastmod>${lastmod.toISOString()}</lastmod>` : ''}
	${changefreq ? `<changefreq>${changefreq}</changefreq>` : ''}
	${priority ? `<priority>${priority}</priority>` : ''}
</url>
	`.trim()
	}

	const rawSitemapEntries = (
		await Promise.all(
			Object.entries(remixContext.routeModules).map(
				async ([id, mod]): Promise<Array<SitemapEntry> | null> => {
					if (id === 'root') return null

					const isResourceRoute = !('default' in mod)

					const handleResult = HandleSchema.safeParse(mod.handle)
					if (!handleResult.success) {
						return null
					}
					const routeGetSitemapEntries = handleResult.data?.getSitemapEntries

					if (routeGetSitemapEntries === null) {
						// opt-out by setting getSitemapEntries to null
						return null
					}
					if (!routeGetSitemapEntries && isResourceRoute) {
						// resource routes should not use the default (because you probably don't want those in the sitemap).
						return null
					}

					const getSitemapEntries =
						routeGetSitemapEntries ?? defaultGetSitemapHandle

					const rawEntries = await getSitemapEntries({
						request,
						id,
						remixContext,
					})

					if (rawEntries === null) return null
					const rawEntryArray = Array.isArray(rawEntries)
						? rawEntries
						: [rawEntries]
					const result = SitemapEntriesSchema.safeParse(rawEntryArray)
					if (!result.success) {
						console.warn(`Invalid sitemap entries for ${id}: ${result.error}`)
						return null
					}
					const entries = result.data
					return entries ? entries.flat().filter(Boolean) : null
				},
			),
		)
	)
		.flatMap(z => z)
		.filter(Boolean)

	const sitemapEntries: Array<SitemapEntry> = []
	for (const entry of rawSitemapEntries) {
		const existingEntryForRoute = sitemapEntries.find(
			e => e.route === entry.route,
		)
		if (existingEntryForRoute) {
			if (!isEqual(existingEntryForRoute, entry)) {
				console.warn(
					`Duplicate route for ${entry.route} with different sitemap data`,
					{ entry, existingEntryForRoute },
				)
			}
		} else {
			sitemapEntries.push(entry)
		}
	}

	return `
<?xml version="1.0" encoding="UTF-8"?>
<urlset
	xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
	xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
	xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9 http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd"
>
	${sitemapEntries.map(entry => getEntry(entry)).join('')}
</urlset>
	`.trim()
}

export { getSitemapXml }
