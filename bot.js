if (process.argv.includes('--debug')) process.env.DEBUG = '1';

const { Client, GatewayIntentBits, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();

const { setupDatabase } = require('./database');
const { debug } = require('./utils');
const initTrades = require('./handlers/trades');
const initReports = require('./handlers/reports');
const initMod = require('./handlers/mod');

class TraderBot {
    constructor() {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages
            ]
        });

        this.dbPath = process.env.DATABASE_PATH || 'trades.db';
        this.trades = null;
        this.reports = null;
        this.mod = null;

        this.setupEvents();
    }

    setupEvents() {
        this.client.once('clientReady', async () => {
            try {
                const db = await setupDatabase(this.dbPath);
                this.trades = initTrades(db);
                this.reports = initReports(db);
                this.mod = initMod(db);

                console.log(`✅ ${this.client.user.tag} is ready!`);
                await this.registerSlashCommands();
            } catch (error) {
                console.error('Error setting up bot:', error);
            }
        });

        this.client.on('interactionCreate', async (interaction) => {
            try {
                if (interaction.isButton()) {
                    debug(`Button interaction from ${interaction.user.tag}: customId=${interaction.customId} guild=${interaction.guild?.id}`);
                    const [action, tradeId] = interaction.customId.split('_');
                    if (action === 'report') {
                        await this.reports.handleReportButton(interaction, tradeId, interaction.user.id);
                    } else {
                        await this.trades.handleButtonInteraction(interaction);
                    }
                } else if (interaction.isChatInputCommand()) {
                    debug(`Slash command from ${interaction.user.tag}: /${interaction.commandName} guild=${interaction.guild?.id}`);
                    debug(`Options: ${JSON.stringify(interaction.options.data)}`);
                    await this.handleSlashCommand(interaction);
                } else if (interaction.isModalSubmit()) {
                    debug(`Modal submit from ${interaction.user.tag}: customId=${interaction.customId}`);
                    await this.reports.handleModalSubmit(interaction);
                } else {
                    debug(`Unhandled interaction type: ${interaction.type} from ${interaction.user.tag}`);
                }
            } catch (error) {
                console.error(`[Error] Unhandled exception in interactionCreate:`, error);
            }
        });
    }

    async registerSlashCommands() {
        const commands = [
            new SlashCommandBuilder()
                .setName('trade')
                .setDescription('Initiate a trade with another user')
                .addUserOption(option =>
                    option.setName('with')
                        .setDescription('User to trade with')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('description')
                        .setDescription('Description of the trade')
                        .setRequired(true)),

            new SlashCommandBuilder()
                .setName('trades')
                .setDescription('View trade history')
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('User to view trades for (default: yourself)')
                        .setRequired(false)),

            new SlashCommandBuilder()
                .setName('tradestats')
                .setDescription('View trading statistics')
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('User to view stats for (default: yourself)')
                        .setRequired(false)),

            new SlashCommandBuilder()
                .setName('report')
                .setDescription('Report a trade or user for problematic behavior')
                .addStringOption(option =>
                    option.setName('type')
                        .setDescription('What to report')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Trade (by ID)', value: 'trade' },
                            { name: 'User (general)', value: 'user' }
                        ))
                .addStringOption(option =>
                    option.setName('reason')
                        .setDescription('Reason for reporting')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Scam/Fraud', value: 'scam' },
                            { name: 'Inappropriate Content', value: 'inappropriate' },
                            { name: 'Harassment', value: 'harassment' },
                            { name: 'Spam', value: 'spam' },
                            { name: 'Other', value: 'other' }
                        ))
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('User to report (for user reports)')
                        .setRequired(false))
                .addIntegerOption(option =>
                    option.setName('tradeid')
                        .setDescription('Trade ID to report (for trade reports)')
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('description')
                        .setDescription('Additional details about the report')
                        .setRequired(false)),

            new SlashCommandBuilder()
                .setName('mod')
                .setDescription('🔒 Moderation tools (Moderators only)')
                .addStringOption(option =>
                    option.setName('action')
                        .setDescription('Moderation action to perform')
                        .setRequired(true)
                        .addChoices(
                            { name: 'View Reports', value: 'reports' },
                            { name: 'Resolve Report', value: 'resolve' },
                            { name: 'Delete Trade', value: 'delete' },
                            { name: 'View Warnings', value: 'warnings' },
                            { name: 'Mark Scammer', value: 'scammer' },
                            { name: 'Remove Scammer Mark', value: 'unscammer' },
                            { name: 'Export Summary CSV', value: 'export_summary' },
                            { name: 'Export Full Stats CSV', value: 'export_full' }
                        ))
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('Target user (for user-related actions)')
                        .setRequired(false))
                .addIntegerOption(option =>
                    option.setName('id')
                        .setDescription('Report ID or Trade ID')
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('reason')
                        .setDescription('Reason/Action details')
                        .setRequired(false)
                        .addChoices(
                            { name: 'Dismiss Report', value: 'dismiss' },
                            { name: 'Cancel Trade', value: 'cancel' },
                            { name: 'Warn User', value: 'warn' },
                            { name: 'Mark Scammer', value: 'mark_scammer' },
                            { name: 'Pending Reports', value: 'pending' },
                            { name: 'Resolved Reports', value: 'resolved' },
                            { name: 'All Reports', value: 'all' }
                        ))
                .addStringOption(option =>
                    option.setName('details')
                        .setDescription('Additional details for scammer marking or deletion reason')
                        .setRequired(false))
        ];

        try {
            const guildId = process.env.GUILD_ID;
            if (guildId) {
                const guild = this.client.guilds.cache.get(guildId);
                await this.client.application.commands.set([]);
                debug('Cleared global commands');
                await guild.commands.set(commands);
                console.log(`✅ Successfully reloaded guild application (/) commands for ${guild.name}.`);
            } else {
                await this.client.application.commands.set(commands);
                console.log('✅ Successfully reloaded global application (/) commands.');
            }
            for (const cmd of commands) {
                const json = cmd.toJSON();
                debug(`Registered /${json.name}`);
                for (const opt of json.options || []) {
                    if (opt.choices?.length) {
                        debug(`  ${opt.name} choices: ${opt.choices.map(c => c.value).join(', ')}`);
                    }
                }
            }
        } catch (error) {
            console.error('Error registering slash commands:', error);
        }
    }

    async handleSlashCommand(interaction) {
        console.log(`[Command] ${interaction.user.tag} (${interaction.user.id}) used: /${interaction.commandName}`);

        if (interaction.commandName === 'trade') {
            const withUser = interaction.options.getUser('with');
            const description = interaction.options.getString('description');
            await this.trades.createTrade(interaction, withUser, description);

        } else if (interaction.commandName === 'trades') {
            const user = interaction.options.getUser('user') || interaction.user;
            await this.trades.showTrades(interaction, user);

        } else if (interaction.commandName === 'tradestats') {
            const user = interaction.options.getUser('user') || interaction.user;
            await this.trades.showTradeStats(interaction, user);

        } else if (interaction.commandName === 'report') {
            const type = interaction.options.getString('type');
            const reason = interaction.options.getString('reason');
            const description = interaction.options.getString('description') || '';

            if (type === 'trade') {
                const tradeId = interaction.options.getInteger('tradeid');
                if (!tradeId) {
                    return interaction.reply({ content: '❌ Trade ID is required for trade reports!', ephemeral: true });
                }
                await this.reports.reportTrade(interaction, tradeId, reason, description);
            } else if (type === 'user') {
                const user = interaction.options.getUser('user');
                if (!user) {
                    return interaction.reply({ content: '❌ User is required for user reports!', ephemeral: true });
                }
                await this.reports.reportUser(interaction, user, reason, description);
            }

        } else if (interaction.commandName === 'mod') {
            const hasPermission = await this.mod.checkModeratorPermission(interaction);
            if (!hasPermission || interaction.replied) return;

            const action = interaction.options.getString('action');
            const user = interaction.options.getUser('user');
            const id = interaction.options.getInteger('id');
            const reason = interaction.options.getString('reason');
            const details = interaction.options.getString('details');

            switch (action) {
                case 'reports':
                    await this.mod.showModeratedTrades(interaction, reason || 'pending');
                    break;
                case 'resolve':
                    if (!id || !reason) {
                        return interaction.reply({ content: '❌ Report ID and action are required!', ephemeral: true });
                    }
                    await this.mod.resolveTradeReport(interaction, id, reason);
                    break;
                case 'delete':
                    if (!id || !details) {
                        return interaction.reply({ content: '❌ Trade ID and reason are required!', ephemeral: true });
                    }
                    await this.mod.deleteTrade(interaction, id, details);
                    break;
                case 'warnings':
                    if (!user) {
                        return interaction.reply({ content: '❌ User is required!', ephemeral: true });
                    }
                    await this.mod.showUserWarnings(interaction, user);
                    break;
                case 'scammer':
                    if (!user || !details) {
                        return interaction.reply({ content: '❌ User and reason are required!', ephemeral: true });
                    }
                    await this.mod.markScammer(interaction, user, details);
                    break;
                case 'unscammer':
                    if (!user) {
                        return interaction.reply({ content: '❌ User is required!', ephemeral: true });
                    }
                    await this.mod.unmarkScammer(interaction, user);
                    break;
                case 'export_summary':
                    await this.mod.exportTradeSummary(interaction);
                    break;
                case 'export_full':
                    await this.mod.exportFullStats(interaction);
                    break;
                default:
                    await interaction.reply({ content: '❌ Invalid moderation action!', ephemeral: true });
            }
        }
    }

    async start() {
        console.log('🚀 Connecting to Discord...');
        const token = process.env.DISCORD_TOKEN;
        if (!token) {
            console.error('❌ Error: DISCORD_TOKEN not found in .env file!');
            console.error('Please add your bot token to the .env file.');
            process.exit(1);
        }

        try {
            await this.client.login(token);
        } catch (error) {
            console.error('❌ Error starting bot:', error);
            process.exit(1);
        }
    }
}

const bot = new TraderBot();
bot.start();
