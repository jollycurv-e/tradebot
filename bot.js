const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
require('dotenv').config();

class TraderBot {
    constructor() {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent
            ]
        });
        
        this.dbPath = process.env.DATABASE_PATH || 'trades.db';
        this.db = null;
        
        this.setupEvents();
        this.setupCommands();
    }

    async cleanupExpiredTrades() {
        const now = new Date().toISOString();
        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE trades SET status = 'expired' WHERE status = 'pending' AND expires_at < ? AND expires_at IS NOT NULL`,
                [now],
                (err) => {
                    if (err) {
                        console.error('Error cleaning up expired trades:', err);
                        reject(err);
                    } else {
                        console.log('Cleaned up expired trades');
                        resolve();
                    }
                }
            );
        });
    }

    async setupDatabase() {
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                // Create tables
                this.db.serialize(() => {
                    this.db.run(`
                        CREATE TABLE IF NOT EXISTS trades (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            initiator_id TEXT NOT NULL,
                            recipient_id TEXT NOT NULL,
                            description TEXT NOT NULL,
                            status TEXT DEFAULT 'pending',
                            created_at DATETIME DEFAULT (datetime('now')),
                            confirmed_at DATETIME NULL,
                            expires_at DATETIME NULL,
                            guild_id TEXT NOT NULL,
                            channel_id TEXT NOT NULL
                        )
                    `);
                    
                    this.db.run(`
                        CREATE TABLE IF NOT EXISTS trade_confirmations (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            trade_id INTEGER NOT NULL,
                            user_id TEXT NOT NULL,
                            confirmed BOOLEAN DEFAULT FALSE,
                            confirmed_at DATETIME NULL,
                            FOREIGN KEY (trade_id) REFERENCES trades (id)
                        )
                    `);
                    
                    this.db.run(`
                        CREATE TABLE IF NOT EXISTS trade_reports (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            trade_id INTEGER NOT NULL,
                            reporter_id TEXT NOT NULL,
                            reported_user_id TEXT NOT NULL,
                            reason TEXT NOT NULL,
                            description TEXT,
                            status TEXT DEFAULT 'pending',
                            created_at DATETIME DEFAULT (datetime('now')),
                            resolved_at DATETIME NULL,
                            resolved_by TEXT NULL,
                            guild_id TEXT NOT NULL,
                            FOREIGN KEY (trade_id) REFERENCES trades (id)
                        )
                    `);
                    
                    this.db.run(`
                        CREATE TABLE IF NOT EXISTS user_warnings (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            user_id TEXT NOT NULL,
                            moderator_id TEXT NOT NULL,
                            reason TEXT NOT NULL,
                            created_at DATETIME DEFAULT (datetime('now')),
                            guild_id TEXT NOT NULL
                        )
                    `);
                    
                    this.db.run(`
                        CREATE TABLE IF NOT EXISTS scammer_list (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            user_id TEXT NOT NULL,
                            moderator_id TEXT NOT NULL,
                            reason TEXT NOT NULL,
                            marked_at DATETIME DEFAULT (datetime('now')),
                            guild_id TEXT NOT NULL,
                            UNIQUE(user_id, guild_id)
                        )
                    `, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            });
        });
    }

    setupEvents() {
        this.client.once('clientReady', async () => {
            try {
                await this.setupDatabase();
                console.log(`✅ ${this.client.user.tag} is ready!`);
                
                // Register slash commands
                await this.registerSlashCommands();
            } catch (error) {
                console.error('Error setting up bot:', error);
            }
        });

        // Remove legacy message handling since we only use slash commands now

        this.client.on('interactionCreate', async (interaction) => {
            if (interaction.isButton()) {
                await this.handleButtonInteraction(interaction);
            } else if (interaction.isChatInputCommand()) {
                await this.handleSlashCommand(interaction);
            } else if (interaction.isModalSubmit()) {
                await this.handleModalSubmit(interaction);
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
                        
            // Report Command (combines reporttrade and reportuser)
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

            // Mod Command (combines all moderator functions)
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
                            { name: 'Remove Scammer Mark', value: 'unscammer' }
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
                await this.client.application.commands.set(commands);
                console.log('✅ Successfully reloaded global application (/) commands.');
        } catch (error) {
            console.error('Error registering slash commands:', error);
        }
    }

    async handleSlashCommand(interaction) {
	console.log(`[Command] ${interaction.user.tag} (${interaction.user.id}) used: /${interaction.commandName}`);
        if (interaction.commandName === 'trade') {
            const withUser = interaction.options.getUser('with');
            const description = interaction.options.getString('description');
            await this.createTrade(interaction, withUser, description);
        } else if (interaction.commandName === 'trades') {
            const user = interaction.options.getUser('user') || interaction.user;
            await this.showTrades(interaction, user);
        } else if (interaction.commandName === 'tradestats') {
            const user = interaction.options.getUser('user') || interaction.user;
            await this.showTradeStats(interaction, user);
        } else if (interaction.commandName === 'report') {
            const type = interaction.options.getString('type');
            const reason = interaction.options.getString('reason');
            const description = interaction.options.getString('description') || '';
            
            if (type === 'trade') {
                const tradeId = interaction.options.getInteger('tradeid');
                if (!tradeId) {
                    return interaction.reply({ content: '❌ Trade ID is required for trade reports!', ephemeral: true });
                }
                await this.reportTrade(interaction, tradeId, reason, description);
            } else if (type === 'user') {
                const user = interaction.options.getUser('user');
                if (!user) {
                    return interaction.reply({ content: '❌ User is required for user reports!', ephemeral: true });
                }
                await this.reportUser(interaction, user, reason, description);
            }
        } else if (interaction.commandName === 'mod') {
            const hasPermission = await this.checkModeratorPermission(interaction);
            if (!hasPermission || interaction.replied) return;
            
            const action = interaction.options.getString('action');
            const user = interaction.options.getUser('user');
            const id = interaction.options.getInteger('id');
            const reason = interaction.options.getString('reason');
            const details = interaction.options.getString('details');
            
            switch (action) {
                case 'reports':
                    const status = reason || 'pending';
                    await this.showModeratedTrades(interaction, status);
                    break;
                case 'resolve':
                    if (!id || !reason) {
                        return interaction.reply({ content: '❌ Report ID and action are required!', ephemeral: true });
                    }
                    await this.resolveTradeReport(interaction, id, reason);
                    break;
                case 'delete':
                    if (!id || !details) {
                        return interaction.reply({ content: '❌ Trade ID and reason are required!', ephemeral: true });
                    }
                    await this.deleteTrade(interaction, id, details);
                    break;
                case 'warnings':
                    if (!user) {
                        return interaction.reply({ content: '❌ User is required!', ephemeral: true });
                    }
                    await this.showUserWarnings(interaction, user);
                    break;
                case 'scammer':
                    if (!user || !details) {
                        return interaction.reply({ content: '❌ User and reason are required!', ephemeral: true });
                    }
                    await this.markScammer(interaction, user, details);
                    break;
                case 'unscammer':
                    if (!user) {
                        return interaction.reply({ content: '❌ User is required!', ephemeral: true });
                    }
                    await this.unmarkScammer(interaction, user);
                    break;
                default:
                    await interaction.reply({ content: '❌ Invalid moderation action!', ephemeral: true });
            }
        }
    }







    async createTrade(context, withUser, description) {
        const author = context.user || context.author;
        const guild = context.guild;
        const channel = context.channel;

        // Validation
        if (withUser.id === author.id) {
            return this.reply(context, '❌ You cannot trade with yourself!');
        }

        if (withUser.bot) {
            return this.reply(context, '❌ You cannot trade with bots!');
        }

        // Check if either user is marked as scammer
        const scammerCheck = await Promise.all([
            new Promise((resolve, reject) => {
                this.db.get(
                    'SELECT * FROM scammer_list WHERE user_id = ? AND guild_id = ?',
                    [author.id, guild.id],
                    (err, row) => err ? reject(err) : resolve(row)
                );
            }),
            new Promise((resolve, reject) => {
                this.db.get(
                    'SELECT * FROM scammer_list WHERE user_id = ? AND guild_id = ?',
                    [withUser.id, guild.id],
                    (err, row) => err ? reject(err) : resolve(row)
                );
            })
        ]);

        const [initiatorScammer, recipientScammer] = scammerCheck;

        // Warn about scammer status
        if (initiatorScammer) {
            return this.reply(context, '❌ You are marked as a scammer and cannot initiate trades!');
        }

        if (recipientScammer) {
            const warningEmbed = new EmbedBuilder()
                .setTitle('⚠️ SCAMMER WARNING')
                .setDescription(`**${withUser.displayName || withUser.username}** is marked as a scammer!`)
                .addFields(
                    { name: 'Reason', value: recipientScammer.reason, inline: true },
                    { name: 'Marked By', value: `<@${recipientScammer.moderator_id}>`, inline: true }
                )
                .setColor('#ff0000')
                .setFooter({ text: 'Proceed with extreme caution!' });

            return this.reply(context, { embeds: [warningEmbed] });
        }

        // Insert trade into database
        const tradeId = await new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO trades (initiator_id, recipient_id, description, guild_id, channel_id) VALUES (?, ?, ?, ?, ?)',
                [author.id, withUser.id, description, guild.id, channel.id],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
	
            );
        });
		console.log(`[Database] Trade #${tradeId} created by ${author.tag} for ${withUser.tag}`);
        // Create confirmation entries - initiator is auto-confirmed, recipient needs to confirm
        const now = new Date().toISOString();
        await Promise.all([
            new Promise((resolve, reject) => {
                this.db.run(
                    'INSERT INTO trade_confirmations (trade_id, user_id, confirmed, confirmed_at) VALUES (?, ?, TRUE, ?)',
                    [tradeId, author.id, now],
                    (err) => err ? reject(err) : resolve()
                );
            }),
            new Promise((resolve, reject) => {
                this.db.run(
                    'INSERT INTO trade_confirmations (trade_id, user_id) VALUES (?, ?)',
                    [tradeId, withUser.id],
                    (err) => err ? reject(err) : resolve()
                );
            })
        ]);

        // Create embed
        const embed = new EmbedBuilder()
            .setTitle('📋 New Trade Proposal')
            .setDescription(`**Trade ID:** ${tradeId}`)
            .addFields(
                { name: '👥 Participants', value: `**Initiator:** <@${author.id}> ✅\n**Recipient:** <@${withUser.id}> ⏳`, inline: false },
                { name: '📝 Description', value: description, inline: false },
                { name: '⏰ Status', value: '⏳ Waiting for recipient to confirm the trade', inline: false }
            )
            .setFooter({ text: 'Recipient must confirm to finalize the trade' })
            .setColor('#0099ff');

        // Create buttons
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`confirm_${tradeId}_${author.id}_${withUser.id}`)
                    .setLabel('✅ Confirm')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`reject_${tradeId}_${author.id}_${withUser.id}`)
                    .setLabel('❌ Reject')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(`report_${tradeId}`)
                    .setLabel('🚨 Report')
                    .setStyle(ButtonStyle.Secondary)
            );

        const content = `<@${author.id}> <@${withUser.id}>`;
        await this.reply(context, { content, embeds: [embed], components: [row] });
    }

    async handleButtonInteraction(interaction) {
        const [action, tradeId, initiatorId, recipientId] = interaction.customId.split('_');
	console.log(`[Button] ${interaction.user.tag} clicked: ${action} on Trade #${tradeId}`);
        const userId = interaction.user.id;

        // For confirmation, only the recipient can confirm
        if (action === 'confirm') {
            if (userId !== recipientId) {
                return interaction.reply({ content: 'Only the recipient can confirm this trade.', ephemeral: true });
            }
            await this.handleConfirm(interaction, tradeId, userId, initiatorId, recipientId);
        } else if (action === 'reject') {
            // Both parties can reject the trade
            if (userId !== initiatorId && userId !== recipientId) {
                return interaction.reply({ content: 'You cannot interact with this trade.', ephemeral: true });
            }
            await this.handleReject(interaction, tradeId);
        } else if (action === 'report') {
            await this.handleReportButton(interaction, tradeId, userId);
        }
    }

    async handleConfirm(interaction, tradeId, userId, initiatorId, recipientId) {
        // Check trade status
        const tradeInfo = await new Promise((resolve, reject) => {
            this.db.get(
                'SELECT status FROM trades WHERE id = ?',
                [tradeId],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });

        if (tradeInfo.status !== 'pending') {
            return interaction.reply({ content: '❌ This trade is no longer pending and cannot be confirmed.', ephemeral: true });
        }

        // Check if recipient already confirmed
        const existingConfirmation = await new Promise((resolve, reject) => {
            this.db.get(
                'SELECT confirmed FROM trade_confirmations WHERE trade_id = ? AND user_id = ?',
                [tradeId, userId],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });

        if (existingConfirmation && existingConfirmation.confirmed) {
            return interaction.reply({ content: 'You have already confirmed this trade.', ephemeral: true });
        }

        // Record recipient confirmation
        const now = new Date().toISOString();
        await new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE trade_confirmations SET confirmed = TRUE, confirmed_at = ? WHERE trade_id = ? AND user_id = ?',
                [now, tradeId, userId],
                (err) => err ? reject(err) : resolve()
            );
        });

        // Since initiator is auto-confirmed and recipient just confirmed, the trade is now complete
        // Finalize trade
        await new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE trades SET status = "confirmed", confirmed_at = ? WHERE id = ?',
                [now, tradeId],
                (err) => err ? reject(err) : resolve()
            );
        });

        // Get trade details
        const tradeDetails = await new Promise((resolve, reject) => {
            this.db.get(
                'SELECT initiator_id, recipient_id, description FROM trades WHERE id = ?',
                [tradeId],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });

        const embed = new EmbedBuilder()
            .setTitle('✅ Trade Confirmed!')
            .setDescription('This trade has been confirmed and finalized!')
            .addFields({
                name: 'Trade Details',
                value: `**Between:** <@${tradeDetails.initiator_id}> ↔️ <@${tradeDetails.recipient_id}>\n**Description:** ${tradeDetails.description}\n**Confirmed:** <t:${Math.floor(Date.now() / 1000)}:R>`,
                inline: false
            })
            .setColor('#00ff00');

        // Disable buttons
        const disabledRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('disabled_confirm')
                    .setLabel('✅ Confirmed')
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId('disabled_reject')
                    .setLabel('❌ Reject')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(true)
            );

        await interaction.update({ embeds: [embed], components: [disabledRow] });
    }

    async handleReject(interaction, tradeId) {
        // Check trade status
        const tradeInfo = await new Promise((resolve, reject) => {
            this.db.get(
                'SELECT status FROM trades WHERE id = ?',
                [tradeId],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });

        if (tradeInfo.status !== 'pending') {
            return interaction.reply({ content: '❌ This trade is no longer pending and cannot be rejected.', ephemeral: true });
        }

        // Update trade status
        await new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE trades SET status = "rejected" WHERE id = ?',
                [tradeId],
                (err) => err ? reject(err) : resolve()
            );
        });

        const embed = new EmbedBuilder()
            .setTitle('❌ Trade Rejected')
            .setDescription('This trade has been rejected.')
            .setColor('#ff0000');

        // Disable buttons
        const disabledRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('disabled_confirm')
                    .setLabel('✅ Confirm')
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId('disabled_reject')
                    .setLabel('❌ Reject')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(true)
            );

        await interaction.update({ embeds: [embed], components: [disabledRow] });
    }

    async showTrades(context, user) {
        const guildId = context.guild.id;
        
        const trades = await new Promise((resolve, reject) => {
            this.db.all(`
                SELECT id, initiator_id, recipient_id, description, status, created_at, confirmed_at, expires_at
                FROM trades 
                WHERE (initiator_id = ? OR recipient_id = ?) AND guild_id = ?
                ORDER BY created_at DESC
                LIMIT 10
            `, [user.id, user.id, guildId], (err, rows) => {
                err ? reject(err) : resolve(rows);
            });
        });

        if (!trades.length) {
            const embed = new EmbedBuilder()
                .setTitle(`📊 Trade History for ${user.displayName || user.username}`)
                .setDescription('No trades found.')
                .setColor('#0099ff');
            return this.reply(context, { embeds: [embed] });
        }

        const embed = new EmbedBuilder()
            .setTitle(`📊 Trade History for ${user.displayName || user.username}`)
            .setDescription(`Showing last ${trades.length} trades`)
            .setColor('#0099ff');

        for (const trade of trades) {
            const otherUserId = trade.initiator_id === user.id ? trade.recipient_id : trade.initiator_id;
            
            const statusEmoji = { confirmed: '✅', rejected: '❌', cancelled: '⛔' }[trade.status] || '❓';
            const role = trade.initiator_id === user.id ? 'Initiator' : 'Recipient';
            
            // Ensure proper UTC timestamp parsing
            const createdTimestamp = Math.floor(new Date(trade.created_at.endsWith('Z') ? trade.created_at : trade.created_at + 'Z').getTime() / 1000);
            const confirmedInfo = trade.confirmed_at ? `\n**Confirmed:** <t:${Math.floor(new Date(trade.confirmed_at.endsWith('Z') ? trade.confirmed_at : trade.confirmed_at + 'Z').getTime() / 1000)}:R>` : '';
            
            embed.addFields({
                name: `${statusEmoji} Trade #${trade.id} - ${trade.status.charAt(0).toUpperCase() + trade.status.slice(1)}`,
                value: `**${role}** with <@${otherUserId}>\n**Description:** ${trade.description}\n**Created:** <t:${createdTimestamp}:R>${confirmedInfo}`,
                inline: false
            });
        }

        await this.reply(context, { embeds: [embed] });
    }

    async showTradeStats(context, user) {
        const guildId = context.guild.id;
        
        // Get statistics
        const stats = await new Promise((resolve, reject) => {
            this.db.get(`
                SELECT 
                    COUNT(*) as total_trades,
                    SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as confirmed_trades,
                    SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected_trades,
                    SUM(CASE WHEN initiator_id = ? THEN 1 ELSE 0 END) as initiated_trades
                FROM trades 
                WHERE (initiator_id = ? OR recipient_id = ?) AND guild_id = ?
            `, [user.id, user.id, user.id, guildId], (err, row) => {
                err ? reject(err) : resolve(row);
            });
        });

        // Get top trading partners
        const partners = await new Promise((resolve, reject) => {
            this.db.all(`
                SELECT 
                    CASE 
                        WHEN initiator_id = ? THEN recipient_id 
                        ELSE initiator_id 
                    END as partner_id,
                    COUNT(*) as trade_count
                FROM trades 
                WHERE (initiator_id = ? OR recipient_id = ?) AND guild_id = ? AND status = 'confirmed'
                GROUP BY partner_id 
                ORDER BY trade_count DESC 
                LIMIT 3
            `, [user.id, user.id, user.id, guildId], (err, rows) => {
                err ? reject(err) : resolve(rows);
            });
        });

        // Get user warnings
        const warnings = await new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM user_warnings WHERE user_id = ? AND guild_id = ? ORDER BY created_at DESC LIMIT 5',
                [user.id, guildId],
                (err, rows) => err ? reject(err) : resolve(rows)
            );
        });

        // Check if user is marked as scammer
        const scammerStatus = await new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM scammer_list WHERE user_id = ? AND guild_id = ?',
                [user.id, guildId],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });

        // Set embed color based on user status
        let embedColor = '#00ff00'; // Default green
        if (scammerStatus) {
            embedColor = '#ff0000'; // Red for scammers
        } else if (warnings.length > 0) {
            embedColor = '#ff9900'; // Orange for users with warnings
        }

        const embed = new EmbedBuilder()
            .setTitle(`📈 Trading Statistics for ${user.displayName || user.username}`)
            .setColor(embedColor);

        embed.addFields(
            {
                name: '📊 Trade Summary',
                value: `**Total Trades:** ${stats.total_trades}\n**✅ Confirmed:** ${stats.confirmed_trades}\n**❌ Rejected:** ${stats.rejected_trades}`,
                inline: true
            },
            {
                name: '🎯 Activity',
                value: `**Initiated:** ${stats.initiated_trades}\n**Received:** ${stats.total_trades - stats.initiated_trades}`,
                inline: true
            }
        );

        if (stats.confirmed_trades > 0) {
            const successRate = ((stats.confirmed_trades / stats.total_trades) * 100).toFixed(1);
            embed.addFields({
                name: '📈 Success Rate',
                value: `${successRate}%`,
                inline: true
            });
        }

        if (partners.length > 0) {
            const partnerList = [];
            for (const partner of partners) {
                partnerList.push(`<@${partner.partner_id}>: ${partner.trade_count} trades`);
            }

            embed.addFields({
                name: '👥 Top Trading Partners',
                value: partnerList.join('\n'),
                inline: false
            });
        }

        // Add scammer status
        if (scammerStatus) {
            const markedTimestamp = Math.floor(new Date(scammerStatus.marked_at + 'Z').getTime() / 1000);
            embed.addFields({
                name: '🚨 SCAMMER WARNING',
                value: `**Reason:** ${scammerStatus.reason}\n**Marked:** <t:${markedTimestamp}:R>\n**By:** <@${scammerStatus.moderator_id}>`,
                inline: false
            });
        }

        // Add warnings section
        if (warnings.length > 0) {
            const warningsList = [];
            for (const warning of warnings.slice(0, 3)) { // Show last 3 warnings
                const warnTimestamp = Math.floor(new Date(warning.created_at + 'Z').getTime() / 1000);
                warningsList.push(`**${warning.reason}** - <t:${warnTimestamp}:R>`);
            }

            embed.addFields({
                name: `⚠️ Recent Warnings (${warnings.length} total)`,
                value: warningsList.join('\n'),
                inline: false
            });

            if (warnings.length > 3) {
                embed.setFooter({ text: `Showing 3 of ${warnings.length} warnings. Use /warnings for full list.` });
            }
        } else if (!scammerStatus) {
            embed.addFields({
                name: '✅ User Status',
                value: 'No warnings or flags on record',
                inline: false
            });
        }

        await this.reply(context, { embeds: [embed] });
    }

    async checkModeratorPermission(interaction) {
        // Check if user has moderator permissions (Manage Messages or Administrator)
        if (!interaction.member.permissions.has('ManageMessages') && !interaction.member.permissions.has('Administrator')) {
            await interaction.reply({ 
                content: '❌ You need "Manage Messages" or "Administrator" permissions to use moderation commands.', 
                ephemeral: true 
            });
            return false;
        }
        return true;
    }

    async reportTrade(interaction, tradeId, reason, description) {
        const reporterId = interaction.user.id;
        const guildId = interaction.guild.id;

        // Check if trade exists
        const trade = await new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM trades WHERE id = ? AND guild_id = ?',
                [tradeId, guildId],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });

        if (!trade) {
            return interaction.reply({ content: '❌ Trade not found!', ephemeral: true });
        }

        // Check if user is involved in the trade
        if (trade.initiator_id !== reporterId && trade.recipient_id !== reporterId) {
            return interaction.reply({ content: '❌ You can only report trades you are involved in!', ephemeral: true });
        }

        // Determine who is being reported
        const reportedUserId = trade.initiator_id === reporterId ? trade.recipient_id : trade.initiator_id;

        // Check if trade is already reported by this user
        const existingReport = await new Promise((resolve, reject) => {
            this.db.get(
                'SELECT id FROM trade_reports WHERE trade_id = ? AND reporter_id = ?',
                [tradeId, reporterId],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });

        if (existingReport) {
            return interaction.reply({ content: '❌ You have already reported this trade!', ephemeral: true });
        }

        // Create report
        const reportInsert = await new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO trade_reports (trade_id, reporter_id, reported_user_id, reason, description, guild_id) VALUES (?, ?, ?, ?, ?, ?)',
                [tradeId, reporterId, reportedUserId, reason, description, guildId],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });

        const embed = new EmbedBuilder()
            .setTitle('📋 Trade Report Submitted')
            .setDescription(`Report ID: ${reportInsert}`)
            .addFields(
                { name: '🔍 Trade ID', value: `#${tradeId}`, inline: true },
                { name: '⚠️ Reason', value: reason, inline: true },
                { name: '👤 Reported User', value: `<@${reportedUserId}>`, inline: true }
            )
            .setColor('#ff9900')
            .setFooter({ text: 'Moderators will review this report shortly' });

        if (description) {
            embed.addFields({ name: '📝 Additional Details', value: description, inline: false });
        }

        await interaction.reply({ embeds: [embed], ephemeral: true });

        // Notify moderators (optional - send to a mod channel if configured)
        const modLogEmbed = new EmbedBuilder()
            .setTitle('🚨 New Trade Report')
            .setDescription(`Report ID: ${reportInsert}`)
            .addFields(
                { name: 'Trade ID', value: `#${tradeId}`, inline: true },
                { name: 'Reporter', value: `<@${reporterId}>`, inline: true },
                { name: 'Reported User', value: `<@${reportedUserId}>`, inline: true },
                { name: 'Reason', value: reason, inline: true },
                { name: 'Trade Description', value: trade.description, inline: false }
            )
            .setColor('#ff0000')

        if (description) {
            modLogEmbed.addFields({ name: 'Report Details', value: description, inline: false });
        }

        // Try to find a mod channel (common names)
        const modChannels = ['mod-logs', 'modlog', 'staff-logs', 'reports'];
        for (const channelName of modChannels) {
            const channel = interaction.guild.channels.cache.find(ch => ch.name === channelName && ch.type === 0);
            if (channel) {
                await channel.send({ embeds: [modLogEmbed] }).catch(() => {});
                break;
            }
        }
    }

    async showModeratedTrades(interaction, status) {
        const guildId = interaction.guild.id;
        
        let query = `
            SELECT tr.*, t.initiator_id, t.recipient_id, t.description, t.status as trade_status
            FROM trade_reports tr
            JOIN trades t ON tr.trade_id = t.id
            WHERE tr.guild_id = ?
        `;
        let params = [guildId];

        if (status !== 'all') {
            query += ' AND tr.status = ?';
            params.push(status);
        }

        query += ' ORDER BY tr.created_at DESC LIMIT 10';

        const reports = await new Promise((resolve, reject) => {
            this.db.all(query, params, (err, rows) => {
                err ? reject(err) : resolve(rows);
            });
        });

        if (!reports.length) {
            const embed = new EmbedBuilder()
                .setTitle('🛡️ Trade Reports')
                .setDescription(`No ${status === 'all' ? '' : status} reports found.`)
                .setColor('#0099ff');
            return interaction.reply({ embeds: [embed] });
        }

        const embed = new EmbedBuilder()
            .setTitle('🛡️ Trade Reports')
            .setDescription(`Showing ${reports.length} ${status === 'all' ? '' : status} reports`)
            .setColor('#ff9900');

        for (const report of reports) {
            const statusEmoji = report.status === 'pending' ? '⏳' : '✅';
            const createdTimestamp = Math.floor(new Date(report.created_at + 'Z').getTime() / 1000);
            
            embed.addFields({
                name: `${statusEmoji} Report #${report.id} - Trade #${report.trade_id}`,
                value: `**Reporter:** <@${report.reporter_id}>\n**Reported:** <@${report.reported_user_id}>\n**Reason:** ${report.reason}\n**Created:** <t:${createdTimestamp}:R>`,
                inline: false
            });
        }

        embed.setFooter({ text: 'Use /mod action:resolve id:<reportid> reason:<action> to handle reports' });

        await interaction.reply({ embeds: [embed] });
    }

    async resolveTradeReport(interaction, reportId, action) {
        const moderatorId = interaction.user.id;
        const guildId = interaction.guild.id;

        // Get report details
        const report = await new Promise((resolve, reject) => {
            this.db.get(`
                SELECT tr.*, t.initiator_id, t.recipient_id, t.description, t.status as trade_status
                FROM trade_reports tr
                JOIN trades t ON tr.trade_id = t.id
                WHERE tr.id = ? AND tr.guild_id = ?
            `, [reportId, guildId], (err, row) => {
                err ? reject(err) : resolve(row);
            });
        });

        if (!report) {
            return interaction.reply({ content: '❌ Report not found!', ephemeral: true });
        }

        if (report.status === 'resolved') {
            return interaction.reply({ content: '❌ This report has already been resolved!', ephemeral: true });
        }

        const now = new Date().toISOString();
        let actionDescription = '';

        if (action === 'dismiss') {
            actionDescription = 'Report dismissed - no action taken';
        } else if (action === 'cancel') {
            // Cancel the trade
            await new Promise((resolve, reject) => {
                this.db.run(
                    'UPDATE trades SET status = "cancelled" WHERE id = ?',
                    [report.trade_id],
                    (err) => err ? reject(err) : resolve()
                );
            });
            actionDescription = 'Trade cancelled due to report';
        } else if (action === 'warn') {
            // Add warning to reported user
            await new Promise((resolve, reject) => {
                this.db.run(
                    'INSERT INTO user_warnings (user_id, moderator_id, reason, guild_id) VALUES (?, ?, ?, ?)',
                    [report.reported_user_id, moderatorId, `Trade report: ${report.reason}`, guildId],
                    (err) => err ? reject(err) : resolve()
                );
            });
            actionDescription = 'User warned and trade cancelled';
            
            // Also cancel trade
            await new Promise((resolve, reject) => {
                this.db.run(
                    'UPDATE trades SET status = "cancelled" WHERE id = ?',
                    [report.trade_id],
                    (err) => err ? reject(err) : resolve()
                );
            });
        }

        // Mark report as resolved
        await new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE trade_reports SET status = "resolved", resolved_at = ?, resolved_by = ? WHERE id = ?',
                [now, moderatorId, reportId],
                (err) => err ? reject(err) : resolve()
            );
        });

        const embed = new EmbedBuilder()
            .setTitle('✅ Report Resolved')
            .addFields(
                { name: 'Report ID', value: `#${reportId}`, inline: true },
                { name: 'Trade ID', value: `#${report.trade_id}`, inline: true },
                { name: 'Action Taken', value: actionDescription, inline: false },
                { name: 'Resolved By', value: `<@${moderatorId}>`, inline: true }
            )
            .setColor('#00ff00')

        await interaction.reply({ embeds: [embed] });
    }

    async deleteTrade(interaction, tradeId, reason) {
        const moderatorId = interaction.user.id;
        const guildId = interaction.guild.id;

        // Check if trade exists
        const trade = await new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM trades WHERE id = ? AND guild_id = ?',
                [tradeId, guildId],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });

        if (!trade) {
            return interaction.reply({ content: '❌ Trade not found!', ephemeral: true });
        }

        // Delete trade and related data
        await new Promise((resolve, reject) => {
            this.db.run('DELETE FROM trade_confirmations WHERE trade_id = ?', [tradeId], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        await new Promise((resolve, reject) => {
            this.db.run('DELETE FROM trades WHERE id = ?', [tradeId], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        const embed = new EmbedBuilder()
            .setTitle('🗑️ Trade Deleted')
            .addFields(
                { name: 'Trade ID', value: `#${tradeId}`, inline: true },
                { name: 'Deleted By', value: `<@${moderatorId}>`, inline: true },
                { name: 'Reason', value: reason, inline: false },
                { name: 'Original Trade', value: `Between <@${trade.initiator_id}> and <@${trade.recipient_id}>\n${trade.description}`, inline: false }
            )
            .setColor('#ff0000')

        await interaction.reply({ embeds: [embed] });
    }

    async showUserWarnings(interaction, user) {
        const guildId = interaction.guild.id;

        const warnings = await new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM user_warnings WHERE user_id = ? AND guild_id = ? ORDER BY created_at DESC',
                [user.id, guildId],
                (err, rows) => err ? reject(err) : resolve(rows)
            );
        });

        const embed = new EmbedBuilder()
            .setTitle(`⚠️ Warnings for ${user.displayName || user.username}`)
            .setColor('#ff9900');

        if (!warnings.length) {
            embed.setDescription('No warnings found for this user.');
        } else {
            embed.setDescription(`Total warnings: ${warnings.length}`);

            for (const warning of warnings.slice(0, 5)) { // Show last 5 warnings
                const createdTimestamp = Math.floor(new Date(warning.created_at + 'Z').getTime() / 1000);
                embed.addFields({
                    name: `Warning #${warning.id}`,
                    value: `**Reason:** ${warning.reason}\n**By:** <@${warning.moderator_id}>\n**Date:** <t:${createdTimestamp}:R>`,
                    inline: false
                });
            }

            if (warnings.length > 5) {
                embed.setFooter({ text: `Showing 5 of ${warnings.length} warnings` });
            }
        }

        await interaction.reply({ embeds: [embed] });
    }

    async handleReportButton(interaction, tradeId, userId) {
        // Check if user is involved in the trade
        const trade = await new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM trades WHERE id = ? AND guild_id = ?',
                [tradeId, interaction.guild.id],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });

        if (!trade) {
            return interaction.reply({ content: '❌ Trade not found!', ephemeral: true });
        }

        if (trade.initiator_id !== userId && trade.recipient_id !== userId) {
            return interaction.reply({ content: '❌ You can only report trades you are involved in!', ephemeral: true });
        }

        // Create a modal for the report
        const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder: ModalActionRow } = require('discord.js');
        
        const modal = new ModalBuilder()
            .setCustomId(`report_modal_${tradeId}`)
            .setTitle('Report Trade');

        const reasonSelect = new TextInputBuilder()
            .setCustomId('reason')
            .setLabel('Reason')
            .setPlaceholder('scam, harassment, spam, inappropriate, other')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(20);

        const descriptionInput = new TextInputBuilder()
            .setCustomId('description')
            .setLabel('Additional details (optional)')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(1000);

        const reasonRow = new ModalActionRow().addComponents(reasonSelect);
        const descriptionRow = new ModalActionRow().addComponents(descriptionInput);

        modal.addComponents(reasonRow, descriptionRow);

        await interaction.showModal(modal);
    }

    async handleModalSubmit(interaction) {
        if (interaction.customId.startsWith('report_modal_')) {
            const tradeId = interaction.customId.split('_')[2];
            const reason = interaction.fields.getTextInputValue('reason').toLowerCase().trim();
            const description = interaction.fields.getTextInputValue('description') || '';

            // Validate reason
            const validReasons = ['scam', 'harassment', 'spam', 'inappropriate', 'other'];
            if (!validReasons.includes(reason)) {
                return interaction.reply({ 
                    content: '❌ Invalid reason! Use: scam, harassment, spam, inappropriate, or other', 
                    ephemeral: true 
                });
            }

            await this.reportTrade(interaction, parseInt(tradeId), reason, description);
        }
    }

    async markScammer(interaction, user, reason) {
        const moderatorId = interaction.user.id;
        const guildId = interaction.guild.id;

        try {
            // Insert or update scammer record
            await new Promise((resolve, reject) => {
                this.db.run(
                    'INSERT OR REPLACE INTO scammer_list (user_id, moderator_id, reason, guild_id) VALUES (?, ?, ?, ?)',
                    [user.id, moderatorId, reason, guildId],
                    (err) => err ? reject(err) : resolve()
                );
            });

            const embed = new EmbedBuilder()
                .setTitle('🚨 User Marked as Scammer')
                .addFields(
                    { name: 'User', value: `<@${user.id}>`, inline: true },
                    { name: 'Marked By', value: `<@${moderatorId}>`, inline: true },
                    { name: 'Reason', value: reason, inline: false }
                )
                .setColor('#ff0000')
                .setFooter({ text: '⚠️ This user is now flagged in all trade interactions' });

            await interaction.reply({ embeds: [embed] });

        } catch (error) {
            await interaction.reply({ content: '❌ Error marking user as scammer.', ephemeral: true });
        }
    }

    async unmarkScammer(interaction, user) {
        const moderatorId = interaction.user.id;
        const guildId = interaction.guild.id;

        // Check if user is marked as scammer
        const scammer = await new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM scammer_list WHERE user_id = ? AND guild_id = ?',
                [user.id, guildId],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });

        if (!scammer) {
            return interaction.reply({ content: '❌ This user is not marked as a scammer.', ephemeral: true });
        }

        // Remove scammer mark
        await new Promise((resolve, reject) => {
            this.db.run(
                'DELETE FROM scammer_list WHERE user_id = ? AND guild_id = ?',
                [user.id, guildId],
                (err) => err ? reject(err) : resolve()
            );
        });

        const embed = new EmbedBuilder()
            .setTitle('✅ Scammer Mark Removed')
            .addFields(
                { name: 'User', value: `<@${user.id}>`, inline: true },
                { name: 'Removed By', value: `<@${moderatorId}>`, inline: true },
                { name: 'Previously Marked For', value: scammer.reason, inline: false }
            )
            .setColor('#00ff00')

        await interaction.reply({ embeds: [embed] });
    }

    async reportUser(interaction, user, reason, description) {
        const reporterId = interaction.user.id;
        const guildId = interaction.guild.id;

        if (user.id === reporterId) {
            return interaction.reply({ content: '❌ You cannot report yourself!', ephemeral: true });
        }

        if (user.bot) {
            return interaction.reply({ content: '❌ You cannot report bots!', ephemeral: true });
        }

        // Create a general user report (not tied to a specific trade)
        const now = new Date().toISOString();
        const reportInsert = await new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO trade_reports (trade_id, reporter_id, reported_user_id, reason, description, guild_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [0, reporterId, user.id, reason, description, guildId, now], // trade_id = 0 for general reports
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });

        const embed = new EmbedBuilder()
            .setTitle('📋 User Report Submitted')
            .setDescription(`Report ID: ${reportInsert}`)
            .addFields(
                { name: '👤 Reported User', value: `<@${user.id}>`, inline: true },
                { name: '⚠️ Reason', value: reason, inline: true },
                { name: '📝 Reporter', value: `<@${reporterId}>`, inline: true }
            )
            .setColor('#ff9900')
            .setFooter({ text: 'Moderators will review this report shortly' });

        if (description) {
            embed.addFields({ name: '📄 Additional Details', value: description, inline: false });
        }

        await interaction.reply({ embeds: [embed], ephemeral: true });

        // Notify moderators
        const modLogEmbed = new EmbedBuilder()
            .setTitle('🚨 New User Report')
            .setDescription(`Report ID: ${reportInsert}`)
            .addFields(
                { name: 'Reporter', value: `<@${reporterId}>`, inline: true },
                { name: 'Reported User', value: `<@${user.id}>`, inline: true },
                { name: 'Reason', value: reason, inline: true },
                { name: 'Type', value: 'General User Report', inline: true }
            )
            .setColor('#ff0000')

        if (description) {
            modLogEmbed.addFields({ name: 'Report Details', value: description, inline: false });
        }

        // Try to find a mod channel
        const modChannels = ['mod-logs', 'modlog', 'staff-logs', 'reports'];
        for (const channelName of modChannels) {
            const channel = interaction.guild.channels.cache.find(ch => ch.name === channelName && ch.type === 0);
            if (channel) {
                await channel.send({ embeds: [modLogEmbed] }).catch(() => {});
                break;
            }
        }
    }

    setupCommands() {
        // Commands are handled through events
    }

    async reply(context, content) {
        if (context.deferred || context.replied) {
            return context.followUp(content);
        } else if (context.reply) {
            return context.reply(content);
        } else {
            return context.channel.send(content);
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

// Create and start the bot
const bot = new TraderBot();
bot.start();
