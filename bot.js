if (process.argv.includes('--debug')) process.env.DEBUG = '1';

const { Client, GatewayIntentBits, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();

const { debug } = require('./utils');
const initTrades = require('./handlers/trades');
const initReports = require('./handlers/reports');
const initMod = require('./handlers/mod');
const initLink = require('./handlers/link');
const { createHubConnection } = require('./hub');

class TraderBot {
    constructor() {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages
            ]
        });

        this.trades = null;
        this.reports = null;
        this.mod = null;
        this.link = null;
        this.hub = createHubConnection();

        this.setupEvents();
    }

    setupEvents() {
        this.client.once('clientReady', async () => {
            try {
                if (!this.hub) {
                    console.error('❌ HUB_API_KEY not set — Hub connection required. Add HUB_API_KEY to .env');
                    process.exit(1);
                }
                this.trades = initTrades(this.hub);
                this.reports = initReports(this.hub);
                this.mod = initMod(this.hub);
                this.link = initLink(this.hub);
                this.trades.listenForMcConfirms(this.client);
                this.reports.listenForMcReports(this.client);

                console.log(`✅ ${this.client.user.tag} is ready!`);
                this.registerSlashCommands();
            } catch (error) {
                console.error('Error setting up bot:', error);
            }
        });

        this.client.on('interactionCreate', async (interaction) => {
            try {
                const DISCORD_EPOCH = 1420070400000n;
                const ageMs = Date.now() - Number((BigInt(interaction.id) >> 22n) + DISCORD_EPOCH);
                if (ageMs > 2500) {
                    debug(`Dropping stale interaction ${interaction.id} (${ageMs}ms old)`);
                    return;
                }

                if (interaction.isButton()) {
                    debug(`Button interaction from ${interaction.user.tag}: customId=${interaction.customId} guild=${interaction.guild?.id}`);
                    const customId = interaction.customId;
                    if (customId.startsWith('report_')) {
                        const tradeId = customId.split('_')[1];
                        await this.reports.handleReportButton(interaction, tradeId, interaction.user.id);
                    } else if (customId.startsWith('mod_resolve_')) {
                        const reportId = customId.split('_')[2];
                        await this.mod.showResolveActions(interaction, reportId);
                    } else if (customId.startsWith('mod_action_')) {
                        const parts = customId.split('_');
                        const reportId = parts[2];
                        const action = parts.slice(3).join('_');
                        await this.mod.handleResolveAction(interaction, reportId, action);
                    } else {
                        await this.trades.handleButtonInteraction(interaction);
                    }
                } else if (interaction.isChatInputCommand()) {
                    debug(`Slash command from ${interaction.user.tag}: /${interaction.commandName} guild=${interaction.guild?.id}`);
                    debug(`Options: ${JSON.stringify(interaction.options.data)}`);
                    await this.handleSlashCommand(interaction);
                } else if (interaction.isModalSubmit()) {
                    debug(`Modal submit from ${interaction.user.tag}: customId=${interaction.customId}`);
                    if (interaction.customId === 'unlink_confirm_modal') {
                        await this.link.confirmUnlink(interaction);
                    } else {
                        await this.reports.handleModalSubmit(interaction);
                    }
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
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('mc_user')
                        .setDescription('Minecraft username to look up trades for')
                        .setRequired(false)),

            new SlashCommandBuilder()
                .setName('tradestats')
                .setDescription('View trading statistics')
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('User to view stats for (default: yourself)')
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('mc_user')
                        .setDescription('Minecraft username to look up stats for')
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
                .setName('link')
                .setDescription('Link your Minecraft account to Discord')
                .addStringOption(option =>
                    option.setName('code')
                        .setDescription('One-time code from !link in Minecraft')
                        .setRequired(true)),

            new SlashCommandBuilder()
                .setName('unlink')
                .setDescription('Unlink your Minecraft account from Discord'),

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
                .addStringOption(option =>
                    option.setName('mc_user')
                        .setDescription('Minecraft UUID (for MC-origin users without a Discord account)')
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('since')
                        .setDescription('Export new trades since this date (YYYY-MM-DD). Defaults to last export date.')
                        .setRequired(false))
        ];

        if (process.env.DEBUG) {
            commands.push(
                new SlashCommandBuilder()
                    .setName('testall')
                    .setDescription('[DEBUG] Ping all Hub endpoints and report status')
            );
        }

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
        const u = interaction.user;
        this.hub.api('POST', '/tradebot/discord-username', [{ user_id: u.id, username: u.globalName || u.username }]).catch(() => {});

        if (interaction.commandName === 'trade') {
            const withUser = interaction.options.getUser('with');
            const description = interaction.options.getString('description');
            await this.trades.createTrade(interaction, withUser, description);

        } else if (interaction.commandName === 'trades') {
            const mcUser = interaction.options.getString('mc_user');
            if (mcUser) {
                await this.trades.showTradesByMcUser(interaction, mcUser);
            } else {
                const user = interaction.options.getUser('user') || interaction.user;
                await this.trades.showTrades(interaction, user);
            }

        } else if (interaction.commandName === 'tradestats') {
            const mcUser = interaction.options.getString('mc_user');
            if (mcUser) {
                await this.trades.showStatsByMcUser(interaction, mcUser);
            } else {
                const user = interaction.options.getUser('user') || interaction.user;
                await this.trades.showTradeStats(interaction, user);
            }

        } else if (interaction.commandName === 'link') {
            const code = interaction.options.getString('code');
            await this.link.linkAccount(interaction, code);

        } else if (interaction.commandName === 'unlink') {
            await this.link.unlinkAccount(interaction);

        } else if (interaction.commandName === 'report') {
            const type = interaction.options.getString('type');
            const reason = interaction.options.getString('reason');
            const description = interaction.options.getString('description') || '';

            if (type === 'trade') {
                const tradeId = interaction.options.getInteger('tradeid');
                if (!tradeId) {
                    return interaction.reply({ content: '❌ Trade ID is required for trade reports!', flags: 64 });
                }
                await this.reports.reportTrade(interaction, tradeId, reason, description);
            } else if (type === 'user') {
                const user = interaction.options.getUser('user');
                if (!user) {
                    return interaction.reply({ content: '❌ User is required for user reports!', flags: 64 });
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
            const since = interaction.options.getString('since');
            const mcUser = interaction.options.getString('mc_user');

            switch (action) {
                case 'reports':
                    await this.mod.showModeratedTrades(interaction, reason || 'pending');
                    break;
                case 'resolve':
                    if (!id || !reason) {
                        return interaction.reply({ content: '❌ Report ID and action are required!', flags: 64 });
                    }
                    await this.mod.resolveTradeReport(interaction, id, reason);
                    break;
                case 'delete':
                    if (!id || !details) {
                        return interaction.reply({ content: '❌ Trade ID and reason are required!', flags: 64 });
                    }
                    await this.mod.deleteTrade(interaction, id, details);
                    break;
                case 'warnings':
                    if (!user) {
                        return interaction.reply({ content: '❌ User is required!', flags: 64 });
                    }
                    await this.mod.showUserWarnings(interaction, user);
                    break;
                case 'scammer':
                    if (!user || !details) {
                        return interaction.reply({ content: '❌ User and reason are required!', flags: 64 });
                    }
                    await this.mod.markScammer(interaction, user, details);
                    break;
                case 'unscammer':
                    if (mcUser) {
                        await this.mod.unmarkScammer(interaction, null, mcUser);
                    } else if (user) {
                        await this.mod.unmarkScammer(interaction, user);
                    } else {
                        return interaction.reply({ content: '❌ Provide a Discord user or mc_user (Minecraft UUID)!', flags: 64 });
                    }
                    break;
                case 'export_summary':
                    await this.mod.exportTradeSummary(interaction, since);
                    break;
                case 'export_full':
                    await this.mod.exportFullStats(interaction, since);
                    break;
                default:
                    await interaction.reply({ content: '❌ Invalid moderation action!', flags: 64 });
            }
        } else if (interaction.commandName === 'testall') {
            if (!process.env.DEBUG) {
                return interaction.reply({ content: '❌ Only available in debug mode.', flags: 64 });
            }
            await this.runTestAll(interaction);
        }
    }

    async runTestAll(interaction) {
        await interaction.deferReply({ flags: 64 });
        const uid = interaction.user.id;
        const guildId = interaction.guild?.id || '0';
        const channelId = interaction.channel?.id || '0';
        const PHANTOM = '000000000000000001';

        const results = [];
        const cleanupTrades = [];
        const cleanupReports = [];

        function pass(label) { results.push(`✅ ${label}`); }
        function fail(label, err) { results.push(`❌ ${label} — ${err.message || err}`); }

        // 1. Create trade → confirm flow
        let tradeId1;
        try {
            const { id } = await this.hub.api('POST', '/tradebot/trade', {
                initiator_id: uid, recipient_id: PHANTOM,
                description: '[testall] confirm flow', guild_id: guildId, channel_id: channelId
            });
            tradeId1 = id;
            cleanupTrades.push(id);
            pass(`Create trade → id ${id}`);
        } catch (err) { fail('Create trade', err); }

        // 2. Confirm trade
        if (tradeId1) {
            try {
                await this.hub.api('POST', `/tradebot/trade/${tradeId1}/confirm`);
                pass('Confirm trade');
            } catch (err) { fail('Confirm trade', err); }
        }

        // 3. Trade appears in list
        try {
            const trades = await this.hub.api('GET', `/tradebot/user/${uid}/trades`);
            Array.isArray(trades) && trades.some(t => t.id === tradeId1)
                ? pass('Trades list contains confirmed trade')
                : fail('Trades list', new Error('trade not found'));
        } catch (err) { fail('Trades list', err); }

        // 4. Stats reflect trade
        try {
            const { stats } = await this.hub.api('GET', `/tradebot/user/${uid}/trade-stats`);
            stats
                ? pass(`Trade stats (completed: ${stats.completed_trades})`)
                : fail('Trade stats', new Error('no stats object'));
        } catch (err) { fail('Trade stats', err); }

        // 5. Report the trade
        let reportId;
        if (tradeId1) {
            try {
                const { id } = await this.hub.api('POST', '/tradebot/report', {
                    trade_id: tradeId1, reporter_id: uid, reported_user_id: PHANTOM,
                    reason: 'other', description: '[testall]', guild_id: guildId
                });
                reportId = id;
                cleanupReports.push(id);
                pass(`Report trade → id ${id}`);
            } catch (err) { fail('Report trade', err); }
        }

        // 6. Verify report exists
        if (reportId) {
            try {
                const { report } = await this.hub.api('GET', `/tradebot/report/${reportId}`);
                report ? pass('Get report') : fail('Get report', new Error('null report'));
            } catch (err) { fail('Get report', err); }
        }

        // 7. Resolve report
        if (reportId) {
            try {
                await this.hub.api('POST', `/tradebot/report/${reportId}/resolve`, {
                    action: 'dismiss', moderator_id: uid, guild_id: guildId
                });
                pass('Resolve report (dismiss)');
            } catch (err) { fail('Resolve report', err); }
        }

        // 8. Create trade → reject flow
        let tradeId2;
        try {
            const { id } = await this.hub.api('POST', '/tradebot/trade', {
                initiator_id: uid, recipient_id: PHANTOM,
                description: '[testall] reject flow', guild_id: guildId, channel_id: channelId
            });
            tradeId2 = id;
            cleanupTrades.push(id);
            pass(`Create trade (reject flow) → id ${id}`);
        } catch (err) { fail('Create trade (reject flow)', err); }

        // 9. Reject trade
        if (tradeId2) {
            try {
                await this.hub.api('POST', `/tradebot/trade/${tradeId2}/reject`);
                pass('Reject trade');
            } catch (err) { fail('Reject trade', err); }
        }

        // 10. Scammer mark / check / unmark
        try {
            await this.hub.api('POST', '/tradebot/scammer', {
                user_id: uid, moderator_id: uid, reason: '[testall]', guild_id: guildId
            });
            pass('Mark scammer');
        } catch (err) { fail('Mark scammer', err); }

        try {
            const { scammer } = await this.hub.api('GET', `/tradebot/user/${uid}/scammer`);
            scammer ? pass('Scammer status shows marked') : fail('Scammer status', new Error('mark not found'));
        } catch (err) { fail('Scammer status', err); }

        try {
            await this.hub.api('DELETE', `/tradebot/scammer/${uid}`);
            pass('Unmark scammer');
        } catch (err) { fail('Unmark scammer', err); }

        // 11. Verify scammer cleared
        try {
            const { scammer } = await this.hub.api('GET', `/tradebot/user/${uid}/scammer`);
            !scammer ? pass('Scammer status cleared') : fail('Scammer status cleared', new Error('mark still present'));
        } catch (err) { fail('Scammer status cleared', err); }

        // Cleanup — reports before trades to avoid FK constraint
        const cleaned = [];
        for (const id of cleanupReports) {
            try { await this.hub.api('DELETE', `/tradebot/report/${id}`); cleaned.push(`report ${id}`); }
            catch (err) { cleaned.push(`report ${id} FAIL`); }
        }
        for (const id of cleanupTrades) {
            try { await this.hub.api('DELETE', `/tradebot/trade/${id}`); cleaned.push(`trade ${id}`); }
            catch (err) { cleaned.push(`trade ${id} FAIL`); }
        }

        const passed = results.filter(r => r.startsWith('✅')).length;
        const total = results.length;
        const content = [
            `**testall — ${passed}/${total} passed**`,
            '```',
            results.join('\n'),
            '```',
            `cleaned: ${cleaned.join(', ') || 'none'}`
        ].join('\n');

        await interaction.editReply({ content });
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
