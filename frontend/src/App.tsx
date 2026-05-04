import React, { Suspense } from 'react'

const MainApp = React.lazy(() => import('./MainApp'))

const App: React.FC = () => (
  <Suspense fallback={<div>Loading...</div>}>
    <MainApp />
  </Suspense>
)

export default App
