import {
  Injector,
  NgZone,
  computed,
  effect,
  inject,
  runInInjectionContext,
  signal,
  untracked,
} from '@angular/core'
import { QueryClient, notifyManager } from '@tanstack/query-core'
import { signalProxy } from './signal-proxy'
import { shouldThrowError } from './util'
import { injectIsRestoring } from './inject-is-restoring'
import type {
  QueryKey,
  QueryObserver,
  QueryObserverResult,
} from '@tanstack/query-core'
import type { CreateBaseQueryOptions } from './types'

/**
 * Base implementation for `injectQuery` and `injectInfiniteQuery`.
 */
export function createBaseQuery<
  TQueryFnData,
  TError,
  TData,
  TQueryData,
  TQueryKey extends QueryKey,
>(
  optionsFn: () => CreateBaseQueryOptions<
    TQueryFnData,
    TError,
    TData,
    TQueryData,
    TQueryKey
  >,
  Observer: typeof QueryObserver,
) {
  const injector = inject(Injector)
  const ngZone = injector.get(NgZone)
  const queryClient = injector.get(QueryClient)
  const isRestoring = injectIsRestoring(injector)

  /**
   * Signal that has the default options from query client applied
   * computed() is used so signals can be inserted into the options
   * making it reactive. Wrapping options in a function ensures embedded expressions
   * are preserved and can keep being applied after signal changes
   */
  const defaultedOptionsSignal = computed(() => {
    const options = runInInjectionContext(injector, () => optionsFn())
    const defaultedOptions = queryClient.defaultQueryOptions(options)
    defaultedOptions._optimisticResults = isRestoring()
      ? 'isRestoring'
      : 'optimistic'
    return defaultedOptions
  })

  const observerSignal = (() => {
    let instance: QueryObserver<
      TQueryFnData,
      TError,
      TData,
      TQueryData,
      TQueryKey
    > | null = null

    return computed(() => {
      return (instance ||= new Observer(queryClient, defaultedOptionsSignal()))
    })
  })()

  const optimisticResultSignal = computed(() =>
    observerSignal().getOptimisticResult(defaultedOptionsSignal()),
  )

  const resultFromSubscriberSignal = signal<QueryObserverResult<
    TData,
    TError
  > | null>(null)

  effect(
    (onCleanup) => {
      const observer = observerSignal()
      const defaultedOptions = defaultedOptionsSignal()

      untracked(() => {
        observer.setOptions(defaultedOptions, {
          // Do not notify on updates because of changes in the options because
          // these changes should already be reflected in the optimistic result.
          listeners: false,
        })
      })
      onCleanup(() => {
        resultFromSubscriberSignal.set(null)
      })
    },
    {
      injector,
    },
  )

  effect((onCleanup) => {
    // observer.trackResult is not used as this optimization is not needed for Angular
    const observer = observerSignal()
    const unsubscribe = isRestoring()
      ? () => undefined
      : untracked(() =>
          ngZone.runOutsideAngular(() =>
            observer.subscribe(
              notifyManager.batchCalls((state) => {
                ngZone.run(() => {
                  if (
                    state.isError &&
                    !state.isFetching &&
                    shouldThrowError(observer.options.throwOnError, [
                      state.error,
                      observer.getCurrentQuery(),
                    ])
                  ) {
                    throw state.error
                  }
                  resultFromSubscriberSignal.set(state)
                })
              }),
            ),
          ),
        )
    onCleanup(unsubscribe)
  })

  return signalProxy(
    computed(() => {
      const subscriberResult = resultFromSubscriberSignal()
      const optimisticResult = optimisticResultSignal()
      return subscriberResult ?? optimisticResult
    }),
  )
}
