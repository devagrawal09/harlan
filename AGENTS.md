When splitting logic into multiple components, don't only split the UI/JSX.
Both the logic and UI should be split into logical components, rather than keeping all the logic in one giant component and only splitting the UI.

Avoid the pattern of putting all the logic inside one giant context and having every component pull from that context.

Only use context when absolutely needed. Try to colocate as much logic as possible in the component with the UI.

We don't need to use useContext wrappers to check for undefined and throw error. Just export the context and call `useContext` directly in the component. It doesn't return a nullable value anymore.

Always create reactive stuff in the component body, not in the JSX
// don't
<something value={createSomething()} />

// do
const value = createSomething()
<something value={value} />

Context providers can inline all the logic instead of just calling another function.

Avoid hasty abstractions.

Async logic no longer needs `createEffect`. We can put async logic directly into createSignal, createMemo, createStore, and createProjection. This includes streaming/realtime subscriptions. Don't use effects for async data fetching/streaming.

You don't need createEffect to reactively set some signal, you can just pass in a reactive function into createSignal/createStore to derive them from other sources.

Minimize the usage of effects and setters. Derive whatever you can.

Use the built in helpers like isPending and Suspense, no need to manage loading state ourselves.

Don't bother with try catch in the reactive graph and keeping track of error state manually. Just throw in the graph and let an `<Errored>` boundary handle it.

Minimize defensive coding. Assume that things will be in the shape typescript expects unless they are coming from a network boundary, and in that case use zod schemas.

Ports 43117 for the API and 3167 for the UI are fixed. If you try to run the dev server and those ports are occupied, that means the dev server is already running. Don't try to run it again, just find the existing process and kill it if you really need to restart the dev server.

Component props don't need to be accessor functions. Just pass the value directly. Access reactively from the undestructured props object.
