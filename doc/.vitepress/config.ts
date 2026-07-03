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
        text: 'Guide',
        items: [
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'MDPA Preview', link: '/guide/mdpa-preview' },
          { text: 'VTK Preview', link: '/guide/vtk-preview' },
          { text: 'Development', link: '/guide/development' }
        ]
      },
      { text: 'Marketplace', link: marketplace }
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'MDPA Preview', link: '/guide/mdpa-preview' },
            { text: 'VTK Preview', link: '/guide/vtk-preview' },
            { text: 'Development', link: '/guide/development' }
          ]
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
      message: 'Released under the MIT License.',
      copyright: 'Kratos Multiphysics'
    }
  }
})
