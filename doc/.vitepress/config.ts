import { defineConfig } from 'vitepress'

const repo = 'https://github.com/loumalouomega/VSCode-MDPA-Preview'
const marketplace =
  'https://marketplace.visualstudio.com/items?itemName=kratos-multiphysics.vscode-mdpa'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'Kratos MDPA Preview',
  description:
    'Preview, organize, and manage Kratos Multiphysics .mdpa model-part files: a 3D mesh viewer with a navigable ModelPart/SubModelPart outline and toggleable layers.',
  lang: 'en-US',

  // Deployed as a GitHub *project page* at
  // https://loumalouomega.github.io/VSCode-MDPA-Preview/
  base: '/VSCode-MDPA-Preview/',
  cleanUrls: true,
  lastUpdated: true,

  head: [
    [
      'link',
      {
        rel: 'icon',
        href: 'https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/icon.png'
      }
    ]
  ],

  themeConfig: {
    logo: 'https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/images/icon.png',

    nav: [
      { text: 'Getting Started', link: '/guide/getting-started' },
      {
        text: 'Features',
        items: [
          { text: 'The 3D Viewer & Outline', link: '/guide/viewer-outline' },
          { text: 'Header Summary', link: '/guide/header-summary' },
          { text: 'Mesh Quality', link: '/guide/mesh-quality' },
          { text: 'Mesh Size', link: '/guide/mesh-size' },
          { text: 'Field Visualization', link: '/guide/field-visualization' },
          { text: 'Sphere / Particle Elements', link: '/guide/sphere-elements' },
          { text: 'Beam / Line Elements', link: '/guide/beam-elements' },
          { text: 'Face Normals', link: '/guide/face-normals' },
          { text: 'Field Integrals', link: '/guide/field-integrals' },
          { text: 'Data Table & CSV', link: '/guide/data-table' },
          { text: 'Plot Over Time', link: '/guide/time-series-plot' },
          { text: 'GiD Postprocess', link: '/guide/gid-postprocess' },
          { text: 'Mesh Editing & History', link: '/guide/mesh-editing' },
          { text: 'MMG Remesh & Level-set', link: '/guide/mmg-remeshing' },
          { text: 'Navigation & Orientation', link: '/guide/navigation' },
          { text: 'Split View', link: '/guide/split-view' },
          { text: 'Recording a Video', link: '/guide/video-recording' }
        ]
      },
      {
        text: 'Simulation',
        items: [
          { text: 'Running Kratos Simulations', link: '/guide/simulation' },
          { text: 'Running a Case', link: '/guide/running-a-case' },
          { text: 'Flowgraph Node Editor', link: '/guide/flowgraph' },
          { text: 'Authoring Problemtypes (JS)', link: '/guide/problemtype-authoring' },
          { text: 'Authoring Problemtypes (Python)', link: '/guide/problemtype-python' }
        ]
      },
      {
        text: 'Formats',
        items: [
          { text: 'VTK / Mesh Preview', link: '/guide/vtk-preview' },
          { text: 'Time-series Playback', link: '/guide/timeline' }
        ]
      },
      {
        text: 'Project',
        items: [
          { text: 'Development', link: '/guide/development' },
          { text: 'UI Design System', link: '/ui-design-system' },
          { text: 'Roadmap', link: '/roadmap' }
        ]
      },
      { text: 'Marketplace', link: marketplace }
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          collapsed: false,
          items: [
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Opening a Preview', link: '/guide/opening-a-preview' }
          ]
        },
        {
          text: 'Features',
          collapsed: false,
          items: [
            { text: 'The 3D Viewer & Outline', link: '/guide/viewer-outline' },
          { text: 'Header Summary', link: '/guide/header-summary' },
            { text: 'Mesh Quality', link: '/guide/mesh-quality' },
            { text: 'Mesh Size', link: '/guide/mesh-size' },
            { text: 'Field Visualization', link: '/guide/field-visualization' },
            { text: 'Sphere / Particle Elements', link: '/guide/sphere-elements' },
            { text: 'Beam / Line Elements', link: '/guide/beam-elements' },
            { text: 'Face Normals', link: '/guide/face-normals' },
            { text: 'Field Integrals', link: '/guide/field-integrals' },
            { text: 'Data Table & CSV', link: '/guide/data-table' },
            { text: 'Plot Over Time', link: '/guide/time-series-plot' },
            { text: 'GiD Postprocess', link: '/guide/gid-postprocess' },
            { text: 'Mesh Editing & History', link: '/guide/mesh-editing' },
            { text: 'MMG Remesh & Level-set', link: '/guide/mmg-remeshing' },
            { text: 'Navigation & Orientation', link: '/guide/navigation' },
            { text: 'Split View', link: '/guide/split-view' },
            { text: 'Recording a Video', link: '/guide/video-recording' }
          ]
        },
        {
          text: 'Simulation',
          collapsed: false,
          items: [
            { text: 'Running Kratos Simulations', link: '/guide/simulation' },
            { text: 'Running a Case', link: '/guide/running-a-case' },
            { text: 'Flowgraph Node Editor', link: '/guide/flowgraph' },
            { text: 'Authoring Problemtypes (JS)', link: '/guide/problemtype-authoring' },
            { text: 'Authoring Problemtypes (Python)', link: '/guide/problemtype-python' }
          ]
        },
        {
          text: 'Formats',
          collapsed: false,
          items: [
            { text: 'VTK / Mesh Preview', link: '/guide/vtk-preview' },
            { text: 'Time-series Playback', link: '/guide/timeline' }
          ]
        },
        {
          text: 'Contributing',
          collapsed: false,
          items: [{ text: 'Development', link: '/guide/development' }]
        }
      ]
    },

    socialLinks: [{ icon: 'github', link: repo }],

    editLink: {
      pattern:
        'https://github.com/loumalouomega/VSCode-MDPA-Preview/edit/master/doc/:path',
      text: 'Edit this page on GitHub'
    },

    search: { provider: 'local' },

    footer: {
      message: 'Released under the GNU AGPL-3.0-or-later License.',
      copyright: 'Kratos Multiphysics'
    }
  }
})
